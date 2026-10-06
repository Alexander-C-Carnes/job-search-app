// Job Search.app: starts the bundled web app (Python, in Contents/Resources) and opens it in the browser.
//
// The app's files are read-only inside the bundle; everything personal is in the profile folder
// (~/JobSearch, or $JOBPIPE_HOME), which the server makes on first start. Quitting the app stops the server.
// Clicking the Dock icon again opens the browser again. On start it checks GitHub for a newer release.
import AppKit
import Foundation

let defaultPort = 8765

final class AppDelegate: NSObject, NSApplicationDelegate {
    var server: Process?
    var url: URL?
    var logURL: URL!
    var quitting = false
    let info = Bundle.main.infoDictionary ?? [:]

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Job Search")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        logURL = logs.appendingPathComponent("server.log")
        start()
        checkForUpdate()
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openInBrowser(nil)
        return false
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        if let s = server, s.isRunning { s.interrupt(); s.waitUntilExit() }
    }

    // MARK: server

    func start() {
        let res = Bundle.main.resourceURL!
        let python = res.appendingPathComponent("python/bin/python3")
        let port = Int(ProcessInfo.processInfo.environment["JOBSEARCH_PORT"] ?? "") ?? defaultPort

        if answers(port: port) {                     // already running (another copy of the app, or `jobsearch run`)
            waitForURL(fromLog: nil, port: port)
            return
        }
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try! FileHandle(forWritingTo: logURL)

        let p = Process()
        p.executableURL = python
        p.arguments = ["-m", "jobpipe", "serve", "--port", String(port), "--no-open"]
        p.currentDirectoryURL = res.appendingPathComponent("app")
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        // Apps start with a bare PATH; add where Claude Code and Homebrew live.
        env["PATH"] = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.npm-global/bin",
                       env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        env["PYTHONDONTWRITEBYTECODE"] = "1"       // the bundle is read-only (and signed)
        env["PYTHONUNBUFFERED"] = "1"
        env["PLAYWRIGHT_BROWSERS_PATH"] = res.appendingPathComponent("ms-playwright").path
        env["JOBSEARCH_APP_VERSION"] = info["CFBundleShortVersionString"] as? String ?? ""
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverStopped(proc.terminationStatus) }
        }
        do { try p.run() } catch {
            fail("Job Search couldn't start its server: \(error.localizedDescription)")
            return
        }
        server = p
        waitForURL(fromLog: logURL, port: port)
    }

    // The server prints "running at http://127.0.0.1:PORT/?token=…" once it's up; open that.
    func waitForURL(fromLog log: URL?, port: Int) {
        let deadline = Date().addingTimeInterval(120)
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            while Date() < deadline {
                if let found = self.urlFromLog(log, port: port) {
                    DispatchQueue.main.async { self.url = found; self.openInBrowser(nil) }
                    return
                }
                if let s = self.server, !s.isRunning { return }
                Thread.sleep(forTimeInterval: 0.4)
            }
            DispatchQueue.main.async { self.fail("Job Search didn't start within two minutes.") }
        }
    }

    func urlFromLog(_ log: URL?, port: Int) -> URL? {
        if let log = log {
            guard let text = try? String(contentsOf: log, encoding: .utf8),
                  let r = text.range(of: #"http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+"#, options: .regularExpression)
            else { return nil }
            return URL(string: String(text[r]))
        }
        // Someone else's server: its token is in the profile's data folder.
        let env = ProcessInfo.processInfo.environment
        let home = env["JOBPIPE_HOME"].map { ($0 as NSString).expandingTildeInPath }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("JobSearch").path
        let data = env["JOBPIPE_DATA_DIR"].map { ($0 as NSString).expandingTildeInPath } ?? home + "/data"
        let token = (try? String(contentsOfFile: data + "/web-token", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return URL(string: "http://127.0.0.1:\(port)/?token=\(token)")
    }

    func answers(port: Int) -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
        req.timeoutInterval = 2
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            ok = (resp as? HTTPURLResponse)?.statusCode == 200
                && String(data: data ?? Data(), encoding: .utf8)?.contains("app.js") == true
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        return ok
    }

    func serverStopped(_ status: Int32) {
        if quitting { return }
        fail("Job Search stopped unexpectedly (exit \(status)).")
    }

    func fail(_ message: String) {
        let tail = (try? String(contentsOf: logURL, encoding: .utf8))
            .map { $0.split(separator: "\n").suffix(12).joined(separator: "\n") } ?? ""
        let a = NSAlert()
        a.messageText = message
        a.informativeText = tail.isEmpty ? "See \(logURL.path)." : "From \(logURL.lastPathComponent):\n\n\(tail)"
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Show Log")
        if a.runModal() == .alertSecondButtonReturn { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
        NSApp.terminate(nil)
    }

    // MARK: menu actions

    @objc func openInBrowser(_ sender: Any?) {
        if let u = url { NSWorkspace.shared.open(u) }
    }

    @objc func showProfile(_ sender: Any?) {
        let env = ProcessInfo.processInfo.environment
        let home = env["JOBPIPE_HOME"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("JobSearch")
        NSWorkspace.shared.open(home)
    }

    @objc func showLog(_ sender: Any?) {
        NSWorkspace.shared.activateFileViewerSelecting([logURL])
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let m = NSMenu()
        m.addItem(withTitle: "Open Job Search", action: #selector(openInBrowser(_:)), keyEquivalent: "o")
        m.addItem(withTitle: "Show Profile Folder", action: #selector(showProfile(_:)), keyEquivalent: "")
        m.addItem(withTitle: "Show Log", action: #selector(showLog(_:)), keyEquivalent: "")
        m.addItem(.separator())
        m.addItem(withTitle: "Quit Job Search", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = m
        NSApp.mainMenu = main
        let dock = NSMenu()
        dock.addItem(withTitle: "Open Job Search", action: #selector(openInBrowser(_:)), keyEquivalent: "")
        dock.addItem(withTitle: "Show Profile Folder", action: #selector(showProfile(_:)), keyEquivalent: "")
        dockMenu = dock
    }

    var dockMenu: NSMenu?
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? { dockMenu }

    // MARK: updates

    // Compares this version with the newest GitHub release of JSUpdateRepo ("owner/repo") and offers it.
    func checkForUpdate() {
        guard let repo = info["JSUpdateRepo"] as? String, !repo.isEmpty,
              let current = info["CFBundleShortVersionString"] as? String,
              let api = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else { return }
        URLSession.shared.dataTask(with: api) { data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = obj["tag_name"] as? String,
                  let page = (obj["html_url"] as? String).flatMap(URL.init(string:)) else { return }
            let latest = tag.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            guard latest.compare(current, options: .numeric) == .orderedDescending else { return }
            DispatchQueue.main.async {
                let a = NSAlert()
                a.messageText = "Job Search \(latest) is available"
                a.informativeText = "You have \(current). Download the new version, quit this one, and drag the new one "
                    + "into Applications. Your profile folder and everything in it stay as they are."
                a.addButton(withTitle: "Download")
                a.addButton(withTitle: "Later")
                if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(page) }
            }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
