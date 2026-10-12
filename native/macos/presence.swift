// Prints {"mic": bool, "micApps": [bundle ids], "camera": bool} as JSON.
//
// Go Away compiles this once with `swiftc` (Xcode Command Line Tools) into ~/.go-away/bin
// and runs it every poll. It catches Google Meet in a browser, Slack huddles, Zoom, Teams…
// without needing tokens, because they all hold the microphone or camera.

import CoreAudio
import CoreMediaIO
import Foundation

func globalAddress(_ selector: AudioObjectPropertySelector,
                   _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func audioObjects(_ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var address = globalAddress(selector)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func uint32Property(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = globalAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = globalAddress(selector)
    var value: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let status = withUnsafeMutablePointer(to: &value) { ptr in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, ptr)
    }
    guard status == noErr, let result = value else { return nil }
    return result as String
}

/// Bundle ID if the process has one; command-line tools (ffmpeg, sox) report an empty one,
/// so fall back to the executable name from the PID.
func processName(_ process: AudioObjectID) -> String {
    if let bundle = stringProperty(process, kAudioProcessPropertyBundleID), !bundle.isEmpty { return bundle }
    var address = globalAddress(kAudioProcessPropertyPID)
    var pid: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    if AudioObjectGetPropertyData(process, &address, 0, nil, &size, &pid) == noErr, pid > 0 {
        var path = [CChar](repeating: 0, count: 4096)
        if proc_pidpath(pid, &path, UInt32(path.count)) > 0 {
            return URL(fileURLWithPath: String(cString: path)).lastPathComponent
        }
    }
    return "unknown"
}

/// macOS 14+: ask each audio client process whether it is capturing input. Exact, and lets
/// us report which app holds the mic (the same information behind the orange menu bar dot).
func micAppsByProcess() -> [String]? {
    guard #available(macOS 14.0, *) else { return nil }
    var apps: [String] = []
    for process in audioObjects(kAudioHardwarePropertyProcessObjectList) {
        if uint32Property(process, kAudioProcessPropertyIsRunningInput) == 1 {
            apps.append(processName(process))
        }
    }
    return apps
}

/// Older macOS: an input-only device (e.g. the built-in microphone) that is running.
/// Devices with output too are skipped, so music on a headset isn't mistaken for a call.
func micInUseByDevice() -> Bool {
    for device in audioObjects(kAudioHardwarePropertyDevices) {
        var inputs = globalAddress(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        var outputs = globalAddress(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput)
        var inSize: UInt32 = 0
        var outSize: UInt32 = 0
        AudioObjectGetPropertyDataSize(device, &inputs, 0, nil, &inSize)
        AudioObjectGetPropertyDataSize(device, &outputs, 0, nil, &outSize)
        if inSize == 0 || outSize > 0 { continue }
        if uint32Property(device, kAudioDevicePropertyDeviceIsRunningSomewhere) == 1 { return true }
    }
    return false
}

func cameraInUse() -> Bool {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    let system = CMIOObjectID(kCMIOObjectSystemObject)
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return false }
    var devices = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(system, &address, 0, nil, size, &used, &devices) == noErr else { return false }
    for device in devices {
        var running = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var value: UInt32 = 0
        var valueUsed: UInt32 = 0
        if CMIOObjectGetPropertyData(device, &running, 0, nil, UInt32(MemoryLayout<UInt32>.size), &valueUsed, &value) == noErr,
           value != 0 {
            return true
        }
    }
    return false
}

let apps = micAppsByProcess()
let result: [String: Any] = [
    "mic": apps.map { !$0.isEmpty } ?? micInUseByDevice(),
    "micApps": apps ?? [],
    "camera": cameraInUse(),
]
let data = try! JSONSerialization.data(withJSONObject: result)
print(String(data: data, encoding: .utf8)!)
