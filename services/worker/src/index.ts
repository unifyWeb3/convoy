// @convoy/worker — BullMQ worker bootstrap.
//
// Runs OFF Vercel (Vercel cannot host long-lived processes). Handles SIGTERM by
// calling worker.close() so in-flight jobs drain rather than being abandoned
// mid-execution.
//
// Scaffold only. Implemented in CVY-006.
export {};
