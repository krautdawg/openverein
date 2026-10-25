# Mobile apps (Android and iOS)

The apps wrap the same web build with [Capacitor](https://capacitorjs.com). They open the club's own OpenVerein server, so API, sign-in, permissions and features are exactly those of the web app; there is no separate native code path. A new web release reaches the apps without a store update.

## Configuration

Build-time variables:

| Variable | Meaning | Example | Read by |
|---|---|---|---|
| `OPENVEREIN_URL` | The club's OpenVerein address the app opens | `https://verein.example.org` | `capacitor.config.ts` (copied into both apps by `cap sync`) |
| `OPENVEREIN_APP_ID` | Store id (unique per published app) | `org.example.verein` | Android: `android/app/build.gradle` |
| `OPENVEREIN_APP_NAME` | Name under the app icon | `SV Lindenhof` | Android: `android/app/build.gradle` |

On iOS, bundle id and display name live in the Xcode project: set `PRODUCT_BUNDLE_IDENTIFIER` and the display name in Xcode (target App → General) and the same bundle id under `ios_signing.bundle_identifier` in `codemagic.yaml`.

Without `OPENVEREIN_URL` the app shows the bundled web build, which only works for local testing.

The address must start with `https://`; the build stops otherwise, so passwords never travel unencrypted. For local development only, `OPENVEREIN_DEV_HTTP=true` allows `http://localhost`, `http://127.0.0.1` or the Android emulator host `http://10.0.2.2`.

## Local builds

```sh
npm ci && npm run build
OPENVEREIN_URL=https://verein.example.org npx cap sync
npx cap open android   # Android Studio (JDK 21, Android SDK)
npx cap open ios       # Xcode on macOS (Swift Package Manager, no CocoaPods)
```

## Codemagic

`codemagic.yaml` has four workflows:

- **android-debug** and **ios-debug** build unsigned debug artefacts (APK, simulator app). They need no credentials and run on any fork.
- **android-release** builds a signed AAB, **ios-release** a signed IPA and uploads it to TestFlight.

For the release workflows, set up once in Codemagic (Team settings):

1. **Android keystore**: Code signing identities → Android keystores → upload the keystore with reference name `openverein`. Codemagic exposes it as `CM_KEYSTORE_PATH`, `CM_KEYSTORE_PASSWORD`, `CM_KEY_ALIAS`, `CM_KEY_PASSWORD`; `android/app/build.gradle` signs the release with them and stays unsigned without them.
2. **App Store Connect**: Integrations → App Store Connect → add an API key named `OpenVerein App Store Connect`. Code signing identities → iOS certificates and provisioning profiles for the bundle id (or let Codemagic fetch them automatically).
3. **Environment group `openverein_release`** with `OPENVEREIN_URL`, `OPENVEREIN_APP_ID` and `OPENVEREIN_APP_NAME` for the club's app. Mark nothing secret here; these values end up in the app.

Never commit keystores, certificates, provisioning profiles or API keys; they live only in Codemagic.

Build numbers come from Codemagic (`BUILD_NUMBER`) for Android; for iOS, set the version in Xcode or with `agvtool` in a pre-build step if you publish often.
