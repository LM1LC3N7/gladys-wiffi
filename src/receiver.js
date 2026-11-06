// -----------------------------------------------------------------------------
// Entry point of the `wiffi-push` sub-container (manifest `containers`, same
// image, command `node src/receiver.js`): the TCP port the Wiffis send their
// telegrams to. No Gladys credentials here: see src/push/service.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { startReceiver } from './push/service.js';

const logger = createLogger({ name: 'wiffi-push' });

try {
  const service = await startReceiver({ env: process.env, logger });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info(`${signal}: stopping`);
      service.stop().finally(() => process.exit(0));
    });
  }
} catch (err) {
  logger.error('The Wiffi receiver could not start', err);
  process.exit(1);
}
