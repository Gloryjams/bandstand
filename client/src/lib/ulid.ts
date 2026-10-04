import { ulid as _ulid } from "ulid";

export function newUlid(): string {
  return _ulid();
}
