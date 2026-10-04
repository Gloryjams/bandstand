import { newUlid } from "./ulid";

// A per-app-instance id, sent on both the sync POST (X-Bandstand-Client header) and
// the EventSource URL (?client=). The server uses it to avoid echoing a device's own
// writes back to it over the live-push stream. Fresh per load is fine — it just needs
// to be consistent between this session's syncs and its event stream.
export const CLIENT_ID = newUlid();
