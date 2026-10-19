# Marina iPhone app

The full Marina interface runs in a persistent `WKWebView` against the existing Vercel deployment. Its tasks, goals, uploads, calendar, notes, chat and cloud saves use the existing web implementation and database. Native additions provide a small Home Screen/Lock Screen widget, a check-in sheet, and a custom expanded notification. This is a native container for the complete web app, not a separate Swift rewrite of every web screen.

## Tasks for today — Home Screen launcher

The **Tasks for today** widget has small and medium Home Screen layouts. Tap a named task to start its shared cloud timer; selecting another task switches at one atomic boundary. The running state shows elapsed time and a discreet Stop control. Stop preserves the task and does not mark it complete. Paging only changes the displayed choices.

Open the app's native control sheet → **Tasks for today** → **Widget connection** → **Connect task widget** after signing in. This explicitly grants task-timer and day-list access in addition to schedule check-in; existing schedule-only connections are not silently upgraded. Choose today's tasks in the same sheet. Current accepted calendar links also supply eligible tasks/subtasks, with parent context and stable IDs. Unapplied proposals and overdue tasks are not automatically added. Add **Marina → Tasks for today** through the Home Screen widget gallery.

Calendar attendance and focused work are now independent. Starting or ending attendance leaves the current work task running. Switching from an older combined calendar timer closes only its measured focus segment and preserves its attendance start with no inferred end. Later attendance confirmation credits only gaps not already owned by focus; even active focus has provisional clock coverage. Correcting attendance never edits that earlier focus segment or restores corrected-away focus minutes. Retries retain command IDs and original times, and stale state is rejected. Actions delayed over ten minutes are rejected unless already committed and replayed by ID. Offline saves are unconfirmed until retried successfully.

Backend prerequisites: additive migrations `M-036-day-work-widget.sql` and `M-037-independent-attendance.sql`, deployed only after a fresh verified backup. Existing records retain their original interpretation until an explicit switch separates focus. The task chooser and widget use the narrow `/api/schedule-shortcuts/work/*` capability; it grants no general API login. No credentials are embedded in the IPA. The widget configurations share the existing extension and bundle IDs.

## Lock Screen widgets and hold-and-swipe picker

Add both rectangular widgets from **Edit Lock Screen → Add Widgets → Marina**:

- **Tasks for today** shows the running work task and elapsed time, with **×** to stop focused work while attendance stays open. When idle, Play starts the suggested today task. The up/down control opens the native task picker.
- **Schedule now** follows the occurrence happening at the current calendar time. Play records attendance start; the checkmark records attendance end without stopping focused work. Overlapping occurrences open the chooser rather than guessing; an earlier missing end remains in the app's review list.

In the native **Tasks for today** sheet, hold the picker, swipe vertically through task names and their parent context, then release to start/switch. Swipe horizontally more than 90 points to cancel. A tap starts the displayed task; accessible adjustable actions only browse, and activation explicitly starts. The ordinary named task buttons remain available. IDs, day, and expected running state are frozen at hold activation, so refreshes cannot change the task beneath the gesture. The server rejects removed tasks or changed running state.

The wheel runs in the app-owned sheet opened from the widget, not inside Apple's Lock Screen widget. Authentication/unlocking is controlled by iOS. [Apple widget interactivity](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities).

## Build and preview before installation

The **Marina iPhone** GitHub Actions workflow builds on macOS. It runs the pure Swift client tests, generates an Xcode project, compiles the app and both extensions, launches a Simulator UI test, captures the sample widget-state gallery, and packages an ad-hoc-signed IPA for AltStore to re-sign. It does not use an Apple developer certificate, upload to TestFlight, or create cloud records. Simulator tests never pair with the production server.

Open the workflow run in GitHub → Actions → Marina iPhone. Its artifact contains `Marina-AltStore.ipa`, Simulator test results, exported preview images and build logs when those stages succeed. A failed build is not an installable release. Public-repository standard GitHub runners normally have no usage charge; check the account’s current billing settings before switching repository visibility or runners.

On a Mac with Xcode and XcodeGen:

```sh
swift test --package-path native/MarinaCore
swift native/Marina/make-icon.swift "$PWD/native/Marina"
cd native/Marina
xcodegen generate
open Marina.xcodeproj
```

Run the Marina scheme on an iPhone Simulator. The native control sheet’s **Preview widget** action shows sample states using the same face component as the widget. This previews layout, not SpringBoard’s widget hosting or live API writes. In Simulator, add the actual installed widget through the Home Screen widget gallery to test its OS presentation. Windows cannot run Apple’s iPhone Simulator; use the cloud test artifacts or a Mac for that stage.

The UI tests also launch an offline check-in fixture with overlapping events and a previous activity whose end is unconfirmed. They exercise the actual UIKit hold-and-slide control and capture its result. Simulator-only test mode intercepts saves and disables pairing, reminders and refresh, so these gestures cannot alter cloud data. This is gesture/layout coverage, not a replacement for the backend’s reconciliation tests or an end-to-end test of every web feature.

The preview and CI tests do not prove physical-device signing, App Group provisioning, notifications, background execution, camera/file dialogs, Google sign-in, or all WebKit behavior. Check those on the actual iPhone before relying on the app daily. A true widget does not receive the app’s arbitrary hold/drag recognizer: it uses App Intent buttons. Hold-and-slide lives in the native check-in sheet and expanded notification content.

CI's Simulator binary uses a deployment-target override of iOS 18.4 to work around [WebKit bug 293831](https://bugs.webkit.org/show_bug.cgi?id=293831) in the runner's iOS 18.5 runtime. The separately built device IPA retains the project's iOS 17 minimum. Simulator coverage therefore does not certify compatibility with iOS 17 on a physical phone.

## Install with AltStore Classic

1. Install AltServer/AltStore using the official Windows instructions. Enable Developer Mode on the iPhone when required.
2. Download and extract the successful Actions artifact. Send `Marina-AltStore.ipa` to the iPhone and install it through AltStore’s My Apps → plus button.
3. **Keep both app extensions** if asked: MarinaWidget and MarinaNotification. They are needed for the widget and expanded card.
4. Open Marina and sign in with the existing Marina password. The app’s WebKit cookie store is separate from Safari; no password is embedded in the app.
5. Tap the small native stacked-card control near the top-right. Open **Tasks for today → Widget connection → Connect task widget**. The authenticated web session creates a revocable schedule/task connection stored in the protected App Group container. No Apple password is sent to Marina or GitHub. Existing focus-capable connections still work; older schedule-only keys require this explicit upgrade for work controls.
6. Add **Tasks for today** on the Home Screen, or **Tasks for today** and **Schedule now** on the Lock Screen. If they do not appear, first open Marina and confirm both extensions were retained.
7. Optionally enable native event reminders from the check-in sheet. Disable the PWA’s schedule reminders if you do not want both sets of alerts.

The fixed source bundle identifiers are `com.abkob.marina`, `com.abkob.marina.widget`, and `com.abkob.marina.notification`. AltStore may append the signing team identity. Updates must keep the same identifiers rather than creating new ones. Registered app IDs and installed app slots are different limits. Free signing expires after seven days and needs refreshing. Keeping the same identifiers reuses the app/extension identities; it does not remove Apple’s expiry limits.

App Group provisioning with free signing must be verified on the actual account/device. The runtime checks both the declared group and the re-signed provisioning profile’s actual groups. If shared storage is unavailable, it reports that error; the full web interface still works, but the widget cannot be presented as connected. No paid account, paid signing service, certificate purchase or enrollment is performed by this repository.

## Reminders and cloud behavior

The free build uses **local notifications**, not APNs remote push. The app refreshes today’s reminders from the current cloud context and, when reminders are enabled, also fetches tomorrow’s schedule. Open and refresh Marina daily and after significant schedule edits. Cached local reminders do not receive instant Vercel updates while the app is closed. Widget refresh timing is controlled by iOS; it is not a guaranteed live schedule feed.

Hold an event notification to expand its native content, then hold/slide Started or Ended to choose the time and release to save. Tap the control for exact date/time entry. Drag down to cancel. Authentication and Lock Screen restrictions remain controlled by iOS. Expanding the system notification and dragging the custom control are separate interactions; one continuous gesture through both is not promised.

Widget Start/End performs the scoped attendance calls using a stable session UUID and explicit actual boundaries. New starts request independent attendance; they do not replace focused work. Task switching carries an expected running ID under the same server lock. End carries the original attendance ID and never stops a newer task timer. The server reconciles measured spans once. Failed network responses retain the original command/time for retry; server rejection is visible instead of being shown as success.

Connections expire after 90 days. **Disconnect widget** revokes the server connection through the signed-in web session before removing local credentials/cache and local reminders. Sign into the full app again if revocation is unauthorized. The web account session and scoped widget connection are separate credentials. Existing schedule-only keys retain their original scope.

The protected shared file contains the scoped widget bearer token; it is never compiled into an IPA, sent in a deep link, logged, or committed. Files use iOS data protection after first unlock and App Group sandbox access. The full browser session cookie stays in WebKit’s cookie store. App/notification/widget writes coordinate through a cross-process lock; pending commands are stored separately from refreshed context.

## Existing features inside the native container

The web view retains its website data store, permits file inputs and media selection through WebKit, exports downloads through the system share sheet, and opens external sites/Google OAuth in Safari’s native browser sheet. Google connection callbacks are handled by the existing public signed-state endpoint; closing the browser after OAuth refreshes the web app. The website still requires network access and valid cloud authentication. Unsaved forms are not automatically reloaded whenever the app becomes active.

References: [Apple widget actions](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities), [expanded notifications](https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications), [free personal-device testing](https://developer.apple.com/help/account/basics/about-your-developer-account), [AltStore Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows), [AltStore App IDs](https://faq.altstore.io/altstore-classic/app-ids).
