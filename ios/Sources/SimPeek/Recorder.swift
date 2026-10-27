#if DEBUG
import Foundation

/// Append-only NDJSON writer. One file per app launch:
///   <root>/<bundleId>/<session>.ndjson        lines: session | start | end
///   <root>/<bundleId>/<session>/<id>.req|.res large or binary bodies
/// Every line is written with a single write(2), so readers can tail the file safely.
final class Recorder: @unchecked Sendable {
    static let shared = Recorder()

    static let inlineBodyLimit = 64 * 1024
    static let captureBodyLimit = 10 * 1024 * 1024
    static let keepSessions = 20

    private let queue = DispatchQueue(label: "simpeek.recorder")
    private let idLock = NSLock()
    private var lastId = 0
    private var handle: FileHandle?
    private var bodiesDir: URL!
    private(set) var sessionFilePath = ""
    private(set) var sessionId = ""

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = .current
        return f
    }()

    static func iso(_ date: Date) -> String { isoFormatter.string(from: date) }

    // MARK: - Setup

    func open() -> Bool {
        let fm = FileManager.default
        let bundleId = Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName
        let pid = ProcessInfo.processInfo.processIdentifier
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        stamp.locale = Locale(identifier: "en_US_POSIX")
        sessionId = "\(stamp.string(from: Date()))-\(pid)"

        for root in Self.candidateRoots() {
            let appDir = root.appendingPathComponent(bundleId, isDirectory: true)
            let file = appDir.appendingPathComponent("\(sessionId).ndjson")
            do {
                try fm.createDirectory(at: appDir, withIntermediateDirectories: true,
                                       attributes: [.posixPermissions: 0o700])
                guard fm.createFile(atPath: file.path, contents: nil,
                                    attributes: [.posixPermissions: 0o600]) else { continue }
                handle = try FileHandle(forWritingTo: file)
                bodiesDir = appDir.appendingPathComponent(sessionId, isDirectory: true)
                sessionFilePath = file.path
                prune(appDir)
                writeSessionLine(bundleId: bundleId, pid: pid)
                return true
            } catch {
                NSLog("[SimPeek] cannot write to %@: %@", appDir.path, error.localizedDescription)
            }
        }
        return false
    }

    private static func candidateRoots() -> [URL] {
        let env = ProcessInfo.processInfo.environment
        var roots: [URL] = []
        if let dir = env["SIMPEEK_DIR"], !dir.isEmpty {
            roots.append(URL(fileURLWithPath: dir, isDirectory: true))
        }
        if let home = env["SIMULATOR_HOST_HOME"], !home.isEmpty {
            roots.append(URL(fileURLWithPath: home).appendingPathComponent(".simpeek", isDirectory: true))
        }
        if let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first {
            roots.append(lib.appendingPathComponent("SimPeek", isDirectory: true))
        }
        return roots
    }

    /// Keeps the newest `keepSessions` launches for this app.
    private func prune(_ appDir: URL) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: appDir.path) else { return }
        let sessions = names.filter { $0.hasSuffix(".ndjson") }.sorted(by: >)
        for name in sessions.dropFirst(Self.keepSessions) {
            let base = String(name.dropLast(".ndjson".count))
            try? fm.removeItem(at: appDir.appendingPathComponent(name))
            try? fm.removeItem(at: appDir.appendingPathComponent(base, isDirectory: true))
        }
    }

    private func writeSessionLine(bundleId: String, pid: Int32) {
        let env = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]
        write([
            "_type": "session",
            "_session": sessionId,
            "bundle": bundleId,
            "appVersion": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "pid": Int(pid),
            "startedDateTime": Self.iso(Date()),
            "device": env["SIMULATOR_DEVICE_NAME"] ?? "",
            "udid": env["SIMULATOR_UDID"] ?? "",
            "os": env["SIMULATOR_RUNTIME_VERSION"] ?? ProcessInfo.processInfo.operatingSystemVersionString,
        ])
    }

    // MARK: - Records

    func nextId() -> Int {
        idLock.lock(); defer { idLock.unlock() }
        lastId += 1
        return lastId
    }

    func recordStart(id: Int, request: URLRequest, body: Data?, date: Date) {
        var req: [String: Any] = [
            "method": request.httpMethod ?? "GET",
            "url": request.url?.absoluteString ?? "",
            "headers": Self.harHeaders(request.allHTTPHeaderFields ?? [:]),
            "queryString": Self.harQuery(request.url),
        ]
        if let body {
            let mime = request.value(forHTTPHeaderField: "Content-Type") ?? ""
            var postData: [String: Any] = ["mimeType": mime]
            postData.merge(bodyFields(body, id: id, ext: "req", mime: mime)) { $1 }
            req["postData"] = postData
        }
        write(["_type": "start", "_id": id, "startedDateTime": Self.iso(date), "request": req])
    }

    func recordEnd(id: Int, start: Date, response: URLResponse?, body: Data, bodyTotal: Int,
                   truncated: Bool, metrics: URLSessionTaskMetrics?, error: Error?) {
        let end = Date()
        var line: [String: Any] = [
            "_type": "end",
            "_id": id,
            "time": Int((end.timeIntervalSince(start) * 1000).rounded()),
        ]
        let transaction = metrics?.transactionMetrics.last
        if let http = response as? HTTPURLResponse {
            let mime = http.value(forHTTPHeaderField: "Content-Type") ?? http.mimeType ?? ""
            var content: [String: Any] = ["size": bodyTotal, "mimeType": mime]
            content.merge(bodyFields(body, id: id, ext: "res", mime: mime)) { $1 }
            if truncated { content["_truncated"] = true }
            line["response"] = [
                "status": http.statusCode,
                "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                "httpVersion": transaction?.networkProtocolName ?? "",
                "headers": Self.harHeaders(http.allHeaderFields),
                "content": content,
                "redirectURL": http.url?.absoluteString ?? "",
            ]
        }
        if let transaction { line["timings"] = Self.harTimings(transaction) }
        if let error = error as NSError? {
            line["_error"] = ["domain": error.domain, "code": error.code, "message": error.localizedDescription]
        }
        write(line)
    }

    // MARK: - Helpers

    private func bodyFields(_ data: Data, id: Int, ext: String, mime: String) -> [String: Any] {
        if data.isEmpty { return ["text": ""] }
        if data.count <= Self.inlineBodyLimit, let text = String(data: data, encoding: .utf8) {
            return ["text": text]
        }
        let name = "\(id).\(ext)"
        queue.async { [bodiesDir] in
            guard let dir = bodiesDir else { return }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: dir.appendingPathComponent(name))
        }
        return ["_file": "\(sessionId)/\(name)"]
    }

    private func write(_ object: [String: Any]) {
        queue.async { [weak self] in
            guard let self, let handle = self.handle,
                  var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
            else { return }
            data.append(0x0A)
            try? handle.write(contentsOf: data)
        }
    }

    private static func harHeaders(_ headers: [AnyHashable: Any]) -> [[String: String]] {
        headers.map { ["name": "\($0.key)", "value": "\($0.value)"] }
            .sorted { $0["name"]! < $1["name"]! }
    }

    private static func harQuery(_ url: URL?) -> [[String: String]] {
        guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return [] }
        return items.map { ["name": $0.name, "value": $0.value ?? ""] }
    }

    private static func harTimings(_ m: URLSessionTaskTransactionMetrics) -> [String: Int] {
        func span(_ a: Date?, _ b: Date?) -> Int {
            guard let a, let b else { return -1 }
            return max(0, Int((b.timeIntervalSince(a) * 1000).rounded()))
        }
        return [
            "dns": span(m.domainLookupStartDate, m.domainLookupEndDate),
            "connect": span(m.connectStartDate, m.connectEndDate),
            "ssl": span(m.secureConnectionStartDate, m.secureConnectionEndDate),
            "send": span(m.requestStartDate, m.requestEndDate),
            "wait": span(m.requestEndDate, m.responseStartDate),
            "receive": span(m.responseStartDate, m.responseEndDate),
        ]
    }
}
#endif
