import { ExecutionRouter } from './router.js';
import { LinkedInAdapter } from './adapters/linkedin.js';
import { EmailAdapter } from './adapters/email.js';
import { WhatsAppAdapter } from './adapters/whatsapp.js';
import { ManualAdapter } from './adapters/manual.js';
import { AntigravityClient } from './antigravity.js';

/** Pre-configured ExecutionRouter with all adapters registered */
const router = new ExecutionRouter();
router.register(new LinkedInAdapter());
router.register(new EmailAdapter());
router.register(new WhatsAppAdapter());
router.register(new ManualAdapter());

export { ExecutionRouter, LinkedInAdapter, EmailAdapter, WhatsAppAdapter, ManualAdapter, AntigravityClient };
export const executionRouter = router;
export type * from './types.js';
export type * from './antigravity.js';