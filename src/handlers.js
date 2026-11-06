// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container. Read only: no onSetValue
// (Gladys answers "not implemented" to any command).
// -----------------------------------------------------------------------------

export function registerHandlers(gladys, app, logger) {
  // Discovery: the Wiffis appear once they sent a telegram.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: the configuration is read again (without end until
  // it answers); the status, the Discovery and the badges are sent again.
  gladys.on('connected', () =>
    app.gladysConnected().catch((err) => logger?.error('Start failed', err)),
  );
}
