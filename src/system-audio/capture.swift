import Foundation
import CoreAudio
import AVFoundation

@available(macOS 14.2, *)
class AudioCapture {
    private let outputURL: URL
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var audioFile: AVAudioFile?
    private var captureFormat: AVAudioFormat?
    private let writeQueue = DispatchQueue(label: "audio.write", qos: .userInteractive)
    private var sigTermSource: DispatchSourceSignal?

    init(outputPath: String) {
        outputURL = URL(fileURLWithPath: outputPath)
    }

    func start() async throws {
        // Create a process tap that captures all-app audio as a stereo mix,
        // independent of which hardware output device is active.
        let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        let tapStatus = AudioHardwareCreateProcessTap(tapDesc, &tapID)
        guard tapStatus == noErr else {
            throw CaptureError.tapFailed(tapStatus)
        }

        // The tap's UUID is used as its identifier in the aggregate device.
        let tapUID = tapDesc.uuid.uuidString

        // Wrap the tap in a private aggregate device so CoreAudio treats it as
        // a regular input device we can install an IOProc on.
        let aggrUID = UUID().uuidString
        let aggrDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String:         "SystemAudioCapture",
            kAudioAggregateDeviceUIDKey as String:          aggrUID,
            kAudioAggregateDeviceIsPrivateKey as String:    true,
            kAudioAggregateDeviceIsStackedKey as String:    false,
            kAudioAggregateDeviceTapListKey as String:      [[kAudioSubTapUIDKey as String: tapUID]],
            kAudioAggregateDeviceTapAutoStartKey as String: false,
        ]
        let aggrStatus = AudioHardwareCreateAggregateDevice(aggrDesc as CFDictionary, &aggregateDeviceID)
        guard aggrStatus == noErr else {
            throw CaptureError.aggregateFailed(aggrStatus)
        }

        // Ask the tap what format its audio is in.
        var asbd = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope:    kAudioObjectPropertyScopeGlobal,
            mElement:  kAudioObjectPropertyElementMain
        )
        let fmtStatus = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
        guard fmtStatus == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
            throw CaptureError.formatFailed(fmtStatus)
        }
        captureFormat = format

        // The tap produces non-interleaved float32. WAV is an interleaved format on disk,
        // so we tell AVAudioFile to accept non-interleaved data in its processing layer
        // while writing a standard interleaved PCM file.
        let fileSettings: [String: Any] = [
            AVFormatIDKey:              kAudioFormatLinearPCM,
            AVSampleRateKey:            format.sampleRate,
            AVNumberOfChannelsKey:      format.channelCount,
            AVLinearPCMBitDepthKey:     32,
            AVLinearPCMIsFloatKey:      true,
            AVLinearPCMIsBigEndianKey:  false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        audioFile = try AVAudioFile(
            forWriting: outputURL,
            settings: fileSettings,
            commonFormat: .pcmFormatFloat32,
            interleaved: format.isInterleaved
        )

        // Install an IOProc on the aggregate device. The callback fires on the
        // CoreAudio I/O thread; we copy the incoming frames and hand them to
        // writeQueue to avoid file I/O on the real-time thread.
        var proc: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateDeviceID, nil) {
            [weak self] _, inInputData, _, _, _ in
            guard let self else { return }
            self.handleInput(inInputData)
        }
        guard procStatus == noErr, let proc else {
            throw CaptureError.ioProcFailed(procStatus)
        }
        ioProcID = proc
        AudioDeviceStart(aggregateDeviceID, ioProcID)

        print("ready")
        fflush(stdout)

        let sig = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sig.setEventHandler { [weak self] in self?.shutdown(); exit(0) }
        signal(SIGTERM, SIG_IGN)
        sig.resume()
        sigTermSource = sig
    }

    // Called on the CoreAudio I/O thread — copy quickly, then write on writeQueue.
    private func handleInput(_ inputData: UnsafePointer<AudioBufferList>) {
        guard let format = captureFormat else { return }

        let bufferCount = Int(inputData.pointee.mNumberBuffers)
        guard bufferCount > 0 else { return }

        let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
        guard bytesPerFrame > 0 else { return }

        let frameCount = withUnsafePointer(to: inputData.pointee.mBuffers) { ptr in
            AVAudioFrameCount(ptr.pointee.mDataByteSize / bytesPerFrame)
        }
        guard frameCount > 0 else { return }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buffer.frameLength = frameCount

        // Copy each AudioBuffer into the PCM buffer (handles both interleaved and non-interleaved).
        withUnsafePointer(to: inputData.pointee.mBuffers) { firstSrc in
            let srcBuffers = UnsafeBufferPointer<AudioBuffer>(start: firstSrc, count: bufferCount)
            let dstABL = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            for i in 0 ..< min(srcBuffers.count, dstABL.count) {
                memcpy(dstABL[i].mData, srcBuffers[i].mData, Int(srcBuffers[i].mDataByteSize))
            }
        }

        writeQueue.async { [weak self] in
            do { try self?.audioFile?.write(from: buffer) }
            catch { fputs("error: write failed: \(error)\n", stderr) }
        }
    }

    private func shutdown() {
        if let proc = ioProcID {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
            ioProcID = nil
        }
        writeQueue.sync { audioFile = nil }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }

    enum CaptureError: LocalizedError {
        case tapFailed(OSStatus), aggregateFailed(OSStatus)
        case formatFailed(OSStatus), ioProcFailed(OSStatus)

        var errorDescription: String? {
            switch self {
            case .tapFailed(let s):
                return "Failed to create process tap (OSStatus \(s)). " +
                       "Open System Settings › Privacy & Security › Screen & System Audio Recording " +
                       "and enable access for your terminal."
            case .aggregateFailed(let s):
                return "Failed to create aggregate device (OSStatus \(s))."
            case .formatFailed(let s):
                return "Failed to query tap audio format (OSStatus \(s))."
            case .ioProcFailed(let s):
                return "Failed to install audio IOProc (OSStatus \(s))."
            }
        }
    }
}

// MARK: - Entry point

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: capture <output.wav>\n", stderr)
    exit(1)
}

if #available(macOS 14.2, *) {
    let capture = AudioCapture(outputPath: CommandLine.arguments[1])
    Task {
        do {
            try await capture.start()
        } catch {
            fputs("error: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
    RunLoop.main.run()
} else {
    fputs("error: System audio capture requires macOS 14.2 or later\n", stderr)
    exit(1)
}
