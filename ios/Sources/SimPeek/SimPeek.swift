import Foundation

/// SimPeek: records every URLSession HTTP(S) exchange of the host app as NDJSON (HAR-shaped)
/// so tools on the Mac (`simpeek tail`, the simpeek MCP server) can read it.
///
/// Two ways in:
/// - Injection (no app changes): the dylib's constructor calls `simpeek_start()` when the app is
///   launched with `DYLD_INSERT_LIBRARIES` (see `simpeek launch`).
/// - SPM: add this package and call `SimPeek.start()` early. Everything is compiled only in DEBUG,
///   so release builds link an empty module and `start()` does nothing.
public enum SimPeek {
    public static func start() {
        #if DEBUG
        startRecording()
        #endif
    }
}

#if DEBUG
extension SimPeek {
    private static let lock = NSLock()
    private static var started = false

    static var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return started
    }

    static func startRecording() {
        lock.lock()
        if started { lock.unlock(); return }
        started = true
        lock.unlock()

        let env = ProcessInfo.processInfo.environment
        if env["SIMPEEK"] == "0" {
            disable()
            return
        }
        guard Recorder.shared.open() else {
            disable()
            return
        }
        Swizzle.injectIntoSessionConfigurations()
        URLProtocol.registerClass(SimPeekURLProtocol.self)
        NSLog("[SimPeek] recording to %@", Recorder.shared.sessionFilePath)
    }

    private static func disable() {
        lock.lock(); started = false; lock.unlock()
    }
}

#endif

@_cdecl("simpeek_start")
public func simpeek_start() {
    SimPeek.start()
}
