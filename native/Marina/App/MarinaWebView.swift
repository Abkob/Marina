import SwiftUI
import WebKit
import SafariServices
import UniformTypeIdentifiers

struct MarinaWebView: UIViewRepresentable {
    @ObservedObject var model: CompanionModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> WKWebView {
        let web = model.webView; web.navigationDelegate = context.coordinator; web.uiDelegate = context.coordinator
        if web.url == nil && !ProcessInfo.processInfo.arguments.contains("--ui-testing") { web.load(URLRequest(url: URL(string: "https://marina-demol1sin.vercel.app")!)) }
        return web
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, SFSafariViewControllerDelegate {
        let model: CompanionModel
        private var oauth = false
        init(model: CompanionModel) { self.model = model }
        private var presenter: UIViewController? {
            var root = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
            while let next = root?.presentedViewController { root = next }; return root
        }
        private func external(_ url: URL) {
            guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                if ["mailto", "tel"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }; return
            }
            oauth = url.host == "accounts.google.com"
            let browser = SFSafariViewController(url: url); browser.delegate = self; presenter?.present(browser, animated: true)
        }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { if oauth { model.webView.reload(); oauth = false } }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if navigationAction.shouldPerformDownload { return .download }
            if url.scheme == "blob" || url.scheme == "about" { return .allow }
            if navigationAction.targetFrame?.isMainFrame == false { return .allow }
            if url.scheme == "https", url.host == "marina-demol1sin.vercel.app" { return .allow }
            external(url); return .cancel
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if url.host == "marina-demol1sin.vercel.app" { webView.load(navigationAction.request) } else { external(url) }
            }; return nil
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy { navigationResponse.canShowMIMEType ? .allow : .download }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); let destination = directory.appendingPathComponent((suggestedFilename as NSString).lastPathComponent); destinations[ObjectIdentifier(download)] = destination; return destination }
            catch { model.webError = "The download could not be saved."; return nil }
        }
        func downloadDidFinish(_ download: WKDownload) {
            // WKDownload does not expose its destination afterward; remember it
            // in the destination delegate so the system share sheet can export it.
            if let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) {
                let sheet = UIActivityViewController(activityItems: [destination], applicationActivities: nil)
                sheet.popoverPresentationController?.sourceView = model.webView; presenter?.present(sheet, animated: true)
            }
        }
        private var destinations: [ObjectIdentifier: URL] = [:]
        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
            let alert = UIAlertController(title: "Download failed", message: "The file was not saved. Check your connection and try again.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default)); presenter?.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { model.webError = "Check your connection and try again. Your cloud data is preserved." } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { model.webError = "The page stopped. Reload to reconnect to Marina." }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "Marina", message: message, preferredStyle: .alert); alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() }); presenter?.present(alert, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "Marina", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) }); alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in completionHandler(true) }); presenter?.present(alert, animated: true)
        }
    }
}
