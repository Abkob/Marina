# Marina iPhone app

The full Marina interface runs in a persistent `WKWebView` against the existing Vercel deployment. Its tasks, goals, uploads, calendar, notes, chat and cloud saves use the existing web implementation and database. Native additions provide a small Home Screen/Lock Screen widget, a check-in sheet, and a custom expanded notification. This is a native container for the complete web app, not a separate Swift rewrite of every web screen.

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

The preview and CI tests do not prove physical-device signing, App Group provisioning, notifications, background execution, camera/file dialogs, Google sign-in, or all WebKit behavior. Check those on the actual iPhone before relying on the app daily. A true widget does not receive the app’s arbitrary hold/drag recognizer: it uses App Intent buttons. Hold-and-slide lives in the native check-in sheet and expanded notification content.

## Install with AltStore Classic

1. Install AltServer/AltStore using the official Windows instructions. Enable Developer Mode on the iPhone when required.
2. Download and extract the successful Actions artifact. Send `Marina-AltStore.ipa` to the iPhone and install it through AltStore’s My Apps → plus button.
3. **Keep both app extensions** if asked: MarinaWidget and MarinaNotification. They are needed for the widget and expanded card.
4. Open Marina and sign in with the existing Marina password. The app’s WebKit cookie store is separate from Safari; no password is embedded in the app.
5. Tap the small native stacked-card control near the top-right. Select **Connect widget**. The authenticated web session creates a revocable schedule-only connection, and the app stores it in the protected App Group container. No Apple password is sent to Marina or GitHub.
6. Add Marina from the iPhone widget gallery. Use the small or medium Home Screen widget, or the rectangular Lock Screen widget. If the widget does not appear, first open Marina and confirm the extensions were retained.
7. Optionally enable native event reminders from the check-in sheet. Disable the PWA’s schedule reminders if you do not want both sets of alerts.

The fixed source bundle identifiers are `com.abkob.marina`, `com.abkob.marina.widget`, and `com.abkob.marina.notification`. AltStore may append the signing team identity. Updates must keep the same identifiers rather than creating new ones. Registered app IDs and installed app slots are different limits. Free signing expires after seven days and needs refreshing. Keeping the same identifiers reuses the app/extension identities; it does not remove Apple’s expiry limits.

App Group provisioning with free signing must be verified on the actual account/device. The runtime checks both the declared group and the re-signed provisioning profile’s actual groups. If shared storage is unavailable, it reports that error; the full web interface still works, but the widget cannot be presented as connected. No paid account, paid signing service, certificate purchase or enrollment is performed by this repository.

## Reminders and cloud behavior

The free build uses **local notifications**, not APNs remote push. The app refreshes today’s reminders from the current cloud context and, when reminders are enabled, also fetches tomorrow’s schedule. Open and refresh Marina daily and after significant schedule edits. Cached local reminders do not receive instant Vercel updates while the app is closed. Widget refresh timing is controlled by iOS; it is not a guaranteed live schedule feed.

Hold an event notification to expand its native content, then hold/slide Started or Ended to choose the time and release to save. Tap the control for exact date/time entry. Drag down to cancel. Authentication and Lock Screen restrictions remain controlled by iOS. Expanding the system notification and dragging the custom control are separate interactions; one continuous gesture through both is not promised.

Widget Start/End performs the same scoped API calls as the existing check-in feature. Every start carries a stable UUID and expected running timer. Switching preserves the previous activity’s missing end. End carries the original session ID and explicit time. The server guards overlap and stale state and saves canonical timer minutes once. Failed network responses retain the original command/time for retry; server rejection is visible instead of being shown as success.

Connections expire after 90 days. **Disconnect widget** revokes the server connection through the signed-in web session before removing local credentials/cache and local reminders. Sign into the full app again if revocation is unauthorized. The web account session and schedule-only widget connection are separate credentials.

The protected shared file contains the schedule-only bearer token; it is never compiled into an IPA, sent in a deep link, logged, or committed. Files use iOS data protection after first unlock and App Group sandbox access. The full browser session cookie stays in WebKit’s cookie store. App/notification/widget writes coordinate through a cross-process lock; pending commands are stored separately from refreshed context.

## Existing features inside the native container

The web view retains its website data store, permits file inputs and media selection through WebKit, exports downloads through the system share sheet, and opens external sites/Google OAuth in Safari’s native browser sheet. Google connection callbacks are handled by the existing public signed-state endpoint; closing the browser after OAuth refreshes the web app. The website still requires network access and valid cloud authentication. Unsaved forms are not automatically reloaded whenever the app becomes active.

References: [Apple widget actions](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities), [expanded notifications](https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications), [free personal-device testing](https://developer.apple.com/help/account/basics/about-your-developer-account), [AltStore Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows), [AltStore App IDs](https://faq.altstore.io/altstore-classic/app-ids).
