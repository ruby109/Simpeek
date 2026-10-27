#if DEBUG
import Foundation

/// Intercepts HTTP(S) requests, replays them through `Forwarder`'s private session, and records
/// the exchange. Client callbacks are made from the forwarder's serial delegate queue, in order.
final class SimPeekURLProtocol: URLProtocol, @unchecked Sendable {
    static let handledKey = "SimPeekHandled"

    private var forwardTask: URLSessionDataTask?
    private var entryId = 0
    private var startDate = Date()
    private var response: URLResponse?
    private var body = Data()
    private var bodyTotal = 0
    private var truncated = false
    private var metrics: URLSessionTaskMetrics?
    private let stopLock = NSLock()
    private var stopped = false

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool {
        guard SimPeek.isRunning,
              let scheme = request.url?.scheme?.lowercased(), scheme == "http" || scheme == "https"
        else { return false }
        return URLProtocol.property(forKey: handledKey, in: request) == nil
    }

    override class func canInit(with task: URLSessionTask) -> Bool {
        if task is URLSessionWebSocketTask || task is URLSessionStreamTask { return false }
        guard let request = task.currentRequest else { return false }
        return canInit(with: request)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let mutable = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else { return }
        let requestBody = request.httpBody ?? Self.drain(request.httpBodyStream)
        if let requestBody { mutable.httpBody = requestBody }
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)
        let forwarded = mutable as URLRequest

        entryId = Recorder.shared.nextId()
        startDate = Date()
        Recorder.shared.recordStart(id: entryId, request: forwarded, body: requestBody, date: startDate)
        forwardTask = Forwarder.shared.start(forwarded, for: self)
    }

    override func stopLoading() {
        stopLock.lock(); stopped = true; stopLock.unlock()
        forwardTask?.cancel()
    }

    // MARK: - Forwarder callbacks (delegate queue)

    func forwarderDidReceive(_ response: URLResponse) {
        self.response = response
        onClient { $0.client?.urlProtocol($0, didReceive: response, cacheStoragePolicy: .notAllowed) }
    }

    func forwarderDidReceive(_ data: Data) {
        bodyTotal += data.count
        let room = Recorder.captureBodyLimit - body.count
        if room > 0 { body.append(data.prefix(room)) }
        if data.count > room { truncated = true }
        onClient { $0.client?.urlProtocol($0, didLoad: data) }
    }

    func forwarderDidCollect(_ metrics: URLSessionTaskMetrics) {
        self.metrics = metrics
    }

    func forwarderDidComplete(_ error: Error?) {
        Recorder.shared.recordEnd(id: entryId, start: startDate, response: response, body: body,
                                  bodyTotal: bodyTotal, truncated: truncated, metrics: metrics, error: error)
        onClient { proto in
            if let error {
                proto.client?.urlProtocol(proto, didFailWithError: error)
            } else {
                proto.client?.urlProtocolDidFinishLoading(proto)
            }
        }
    }

    // MARK: - Helpers

    /// Runs on the forwarder's serial queue; nothing is delivered after `stopLoading`.
    private func onClient(_ block: (SimPeekURLProtocol) -> Void) {
        stopLock.lock(); let isStopped = stopped; stopLock.unlock()
        if !isStopped { block(self) }
    }

    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
            if data.count > Recorder.captureBodyLimit * 5 { break }
        }
        return data
    }
}

/// Owns the private URLSession that actually performs intercepted requests.
final class Forwarder: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = Forwarder()

    private let lock = NSLock()
    private var protocols: [Int: SimPeekURLProtocol] = [:]
    private lazy var session: URLSession = {
        let config = Swizzle.pristineDefaultConfiguration()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "simpeek.forwarder"
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    func start(_ request: URLRequest, for proto: SimPeekURLProtocol) -> URLSessionDataTask {
        let task = session.dataTask(with: request)
        lock.lock(); protocols[task.taskIdentifier] = proto; lock.unlock()
        task.resume()
        return task
    }

    private func proto(_ task: URLSessionTask) -> SimPeekURLProtocol? {
        lock.lock(); defer { lock.unlock() }
        return protocols[task.taskIdentifier]
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        proto(dataTask)?.forwarderDidReceive(response)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        proto(dataTask)?.forwarderDidReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        proto(task)?.forwarderDidCollect(metrics)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let proto = protocols.removeValue(forKey: task.taskIdentifier); lock.unlock()
        proto?.forwarderDidComplete(error)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    willCacheResponse proposedResponse: CachedURLResponse,
                    completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil)
    }
}
#endif
