/**
 * macOS notarization script (optional - only runs when APPLE_ID env var is set).
 * Set the following env vars to enable notarization:
 *   APPLE_ID          - Your Apple Developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD - App-specific password from appleid.apple.com
 *   APPLE_TEAM_ID     - Your Apple Team ID
 */

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;

  if (!process.env.APPLE_ID) {
    console.log('Skipping notarization: APPLE_ID not set.');
    return;
  }

  const { notarize } = await import('@electron/notarize').catch(() => {
    console.log('Skipping notarization: @electron/notarize not installed.');
    return { notarize: null };
  });

  if (!notarize) return;

  console.log(`Notarizing ${appName}...`);

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });

  console.log('Notarization complete.');
};
