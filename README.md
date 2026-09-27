# GarageInventoryApp

Cross-platform inventory management for a garage, built with Expo React Native, React Native Paper, Firebase Authentication, and Cloud Firestore.

## Features

- Email/password sign-in and logout
- Persistent Firebase sign-in on Android/iOS, with a password visibility toggle
- Firestore collections: `engine_oils`, `oil_filters`, `diesel_filters`, and `spare_parts`
- Add, edit, delete, search, and filter inventory
- Quantity, brand, unit price, barcode/QR value, and barcode-based quantity sales
- Mobile app lock with a six-digit PIN and optional fingerprint/Face ID unlock
- Cross-category dashboard charts for stock levels, category mix, and seven-day stock movement
- Android/iOS barcode and QR scanning; responsive web dashboard
- Branded tractor splash screen shown for a minimum of 30 seconds before login

## Setup

1. Install Node.js 18.13 or newer (Node.js LTS is recommended).
2. Copy `.env.example` to `.env` and fill it with the Firebase web app configuration from Firebase Console > Project settings.
3. In Firebase Authentication, enable Email/Password. Create a user or add a registration screen before production use.
4. Create the four inventory collections listed above and deploy `firestore.rules` with the Firebase CLI. The `inventory_history` collection is created automatically when an item is added, edited, deleted, or sold. Movement history starts after the updated rules and app are deployed; earlier changes cannot be reconstructed. Every item document uses `name`, `brand`, `quantity`, `unitPrice`, `barcode`, `createdAt`, and `updatedAt`.
5. Run `npm install`, then `npm run web`, `npm run android`, or `npm run ios`.

## CI/CD and Firebase Hosting

The GitHub Actions workflow exports the Expo web app and deploys it to Firebase Hosting whenever `master` or `main` is updated. It requires Firebase Hosting to be enabled for the `garageinventoryapp` Firebase project and the GitHub Actions secret `FIREBASE_SERVICE_ACCOUNT`, containing a service-account JSON key authorized to deploy Hosting. Add it under **GitHub repository > Settings > Secrets and variables > Actions**. Never commit the service-account JSON.

The first deployment publishes the site at `https://garageinventoryapp.web.app` (and the matching `firebaseapp.com` domain). Check the `Firebase Hosting` workflow run for the final URL and deployment status.

## Android APK and sharing

The `Android APK` workflow builds an installable APK on pushes to `master`/`main` and can also be started from **GitHub repository > Actions > Android APK > Run workflow**. It requires an `EXPO_TOKEN` Actions secret and an EAS project linked to this Expo app. Set that up once from the project folder with `npx eas-cli@latest init` and `npx eas-cli@latest build:configure`, then commit the generated EAS project ID in `app.json`. Configure the six `EXPO_PUBLIC_FIREBASE_*` variables in the Expo project's EAS `preview` environment before the first build.

After the workflow succeeds, open its GitHub Actions run and download the `GarageInventoryApp-APK` artifact. Share the downloaded `.apk` file directly; recipients may need to allow installation from their browser or file manager. Alternatively, build manually with `npm run build:android` and download the APK from the EAS build page. The APK is a standalone app with the GarageInventoryApp launcher icon; it does not require Expo Go.

On Android and iOS, sign in once to set a six-digit local app PIN. The PIN is stored using the operating system's encrypted secure storage. Enable fingerprint or Face ID during setup to use biometrics on later launches; the PIN remains available as a fallback. This device lock is separate from Firebase account authentication. For native builds, regenerate/rebuild the app after installing the Expo authentication and secure-storage modules.

### Firebase API key error

If the browser shows `auth/api-key-not-valid-please-pass-a-valid-api-key`, the value in `.env` is not usable by Identity Toolkit. In Google Cloud Console, open **APIs & Services > Credentials**, click **Browser key (auto created by Firebase)**, and temporarily choose **Don't restrict key** under API restrictions, then save. This is a diagnostic step; after login works, restrict the key to the Firebase/Identity Toolkit APIs used by this app. Also confirm **Identity Toolkit API** is enabled under **APIs & Services > Library**.

Next, in Firebase Console open **Project settings > General > Your apps > Web app > SDK setup and configuration**, copy the current `apiKey` exactly into `EXPO_PUBLIC_FIREBASE_API_KEY`, and save `.env`. Do not copy the API key from an old screenshot or another Firebase project. Then stop the Expo server and restart it with:

```powershell
npm run web -- --port 8081 --clear
```

If the copied key still fails, open Google Cloud Console **APIs & Services > Credentials**, check that the key has not been deleted or restricted away from Identity Toolkit, and ensure the Identity Toolkit API is enabled. The Firebase project ID and app ID in `.env` must come from the same web app configuration.

## Start the app

From the project folder:

```powershell
npm install
npm start
```

Then press `w` for the desktop web app, `a` for Android, or `i` for iOS. You can also run `npm run web` directly. The native app uses a branded `#173f35` splash screen while Expo loads the JavaScript bundle.

Firebase login is persisted on Android/iOS, so reopening the installed app goes to the local app PIN/biometric unlock rather than asking for the account password again. Signing out explicitly returns to Firebase login.

## Android APK

Install EAS CLI, run `eas login`, then `eas build:configure`. Use `npm run build:android` for a preview APK. Install that APK on the emulator to get a separate GarageInventoryApp launcher icon and app; Expo Go will continue to show its own icon while running a project preview. Set the same `EXPO_PUBLIC_*` variables in the EAS build environment. The launcher icon is configured in `app.json` and uses `assets/icon.png` plus `assets/adaptive-icon.png`.

Never commit `.env`, service-account keys, or native Firebase credential files.