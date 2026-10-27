#if DEBUG
import Foundation
import ObjectiveC

/// Puts `SimPeekURLProtocol` first in `protocolClasses` of every default / ephemeral
/// configuration, so sessions the app builds itself are recorded too.
/// Background configurations cannot use custom protocols and are left alone.
enum Swizzle {
    private typealias ConfigFactory = @convention(c) (AnyClass, Selector) -> URLSessionConfiguration

    private static let lock = NSLock()
    private static var originalDefault: ConfigFactory?
    private static var done = false

    static func injectIntoSessionConfigurations() {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true
        for name in ["defaultSessionConfiguration", "ephemeralSessionConfiguration"] {
            let selector = NSSelectorFromString(name)
            guard let method = class_getClassMethod(URLSessionConfiguration.self, selector) else { continue }
            let original = unsafeBitCast(method_getImplementation(method), to: ConfigFactory.self)
            if name == "defaultSessionConfiguration" { originalDefault = original }
            let replacement: @convention(block) (AnyClass) -> URLSessionConfiguration = { cls in
                let config = original(cls, selector)
                var classes = config.protocolClasses ?? []
                if !classes.contains(where: { $0 == SimPeekURLProtocol.self }) {
                    classes.insert(SimPeekURLProtocol.self, at: 0)
                    config.protocolClasses = classes
                }
                return config
            }
            method_setImplementation(method, imp_implementationWithBlock(replacement))
        }
    }

    /// A default configuration without SimPeek, for the forwarding session.
    static func pristineDefaultConfiguration() -> URLSessionConfiguration {
        lock.lock(); let original = originalDefault; lock.unlock()
        let config = original.map { $0(URLSessionConfiguration.self, NSSelectorFromString("defaultSessionConfiguration")) }
            ?? URLSessionConfiguration.default
        config.protocolClasses = (config.protocolClasses ?? []).filter { $0 != SimPeekURLProtocol.self }
        return config
    }
}
#endif
