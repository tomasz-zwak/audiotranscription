import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreAudio

@available(macOS 12.3, *)
class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputURL: URL
    private var stream: SCStream?
    private var audioFile: AVAudioFile?
    private var sigTermSource: DispatchSourceSignal?  // must outlive start()
    private let writeQueue = DispatchQueue(label: "audio.capture.write", qos: .userInteractive)

    init(outputPath: String) {
        self.outputURL = URL(fileURLWithPath: outputPath)
        super.init()
    }

    func start() async throws {
        // Request permission if needed (shows System Settings prompt on first run)
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            for _ in 0..<60 {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                if CGPreflightScreenCaptureAccess() { break }
            }
        }

        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureError.permissionDenied
        }

        try await startStream()

        print("ready")
        fflush(stdout)

        setupOutputDeviceListener()

        // Shut down cleanly on SIGTERM so the WAV file is fully flushed.
        // Stored as an instance variable so it stays alive after start() returns.
        let sig = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sig.setEventHandler { [weak self] in
            self?.writeQueue.sync { self?.audioFile = nil }
            exit(0)
        }
        signal(SIGTERM, SIG_IGN)
        sig.resume()
        self.sigTermSource = sig
    }

    // MARK: - Stream lifecycle

    private func startStream() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let scStream = SCStream(filter: makeFilter(display: display), configuration: makeConfig(), delegate: self)
        stream = scStream
        try scStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: writeQueue)
        try await scStream.startCapture()
    }

    private func restartStream() async {
        fputs("info: output device changed — restarting capture\n", stderr)

        if let old = stream {
            stream = nil
            try? await old.stopCapture()
        }

        // Brief pause for the OS to settle the new device
        try? await Task.sleep(nanoseconds: 300_000_000)

        do {
            try await startStream()
        } catch {
            fputs("error: failed to restart capture: \(error.localizedDescription)\n", stderr)
        }
    }

    // MARK: - Output device change listener

    private func setupOutputDeviceListener() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            DispatchQueue.main
        ) { [weak self] _, _ in
            guard let self else { return }
            Task { await self.restartStream() }
        }
    }

    // MARK: - Config helpers

    private func makeConfig() -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = false
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false
        return config
    }

    private func makeFilter(display: SCDisplay) -> SCContentFilter {
        SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              let formatDesc = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: formatDesc)

        let frameCount = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frameCount > 0 else { return }

        if audioFile == nil {
            guard let file = try? AVAudioFile(forWriting: outputURL, settings: format.settings) else {
                fputs("error: could not create output file at \(outputURL.path)\n", stderr)
                return
            }
            audioFile = file
        }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        pcmBuffer.frameLength = frameCount

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer, at: 0, frameCount: Int32(frameCount),
            into: pcmBuffer.mutableAudioBufferList
        )
        guard status == noErr else {
            fputs("error: CMSampleBufferCopyPCMDataIntoAudioBufferList failed (\(status))\n", stderr)
            return
        }

        do {
            try audioFile?.write(from: pcmBuffer)
        } catch {
            fputs("error: audio write failed: \(error)\n", stderr)
        }
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // Ignore errors from streams we intentionally replaced during a restart
        guard stream === self.stream else { return }
        fputs("error: stream stopped: \(error.localizedDescription)\n", stderr)
        writeQueue.sync { audioFile = nil }
        exit(1)
    }

    // MARK: - Errors

    enum CaptureError: LocalizedError {
        case permissionDenied, noDisplay

        var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Screen recording permission not granted. " +
                       "Open System Settings › Privacy & Security › Screen & System Audio Recording " +
                       "and enable access for your terminal."
            case .noDisplay:
                return "No display found — cannot initialise ScreenCaptureKit."
            }
        }
    }
}

// MARK: - Entry point

guard #available(macOS 12.3, *) else {
    fputs("error: ScreenCaptureKit requires macOS 12.3 or later\n", stderr)
    exit(1)
}

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: capture <output.wav>\n", stderr)
    exit(1)
}

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
