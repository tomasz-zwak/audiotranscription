import Foundation
import ScreenCaptureKit
import AVFoundation

@available(macOS 12.3, *)
class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputURL: URL
    private var stream: SCStream?
    private var audioFile: AVAudioFile?
    private var sigTermSource: DispatchSourceSignal?  // must outlive start()
    // Serial queue so file writes never race
    private let writeQueue = DispatchQueue(label: "audio.capture.write", qos: .userInteractive)

    init(outputPath: String) {
        self.outputURL = URL(fileURLWithPath: outputPath)
        super.init()
    }

    func start() async throws {
        // Request permission if needed (shows System Settings prompt on first run)
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            // Wait up to 60 s for the user to grant access in System Settings
            for _ in 0..<60 {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                if CGPreflightScreenCaptureAccess() { break }
            }
        }

        guard CGPreflightScreenCaptureAccess() else {
            throw CaptureError.permissionDenied
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = false
        // Minimise video work — we only want audio
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let scStream = SCStream(filter: filter, configuration: config, delegate: self)
        stream = scStream
        try scStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: writeQueue)
        try await scStream.startCapture()

        print("ready")
        fflush(stdout)

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

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              let formatDesc = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: formatDesc)

        let frameCount = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frameCount > 0 else { return }

        // Create the file on the first buffer so we know the real output format
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
