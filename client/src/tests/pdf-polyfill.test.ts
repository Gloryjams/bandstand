import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import source from "../lib/promise-with-resolvers.mjs?raw";

test("the iOS compatibility shim resolves, rejects and preserves Promise subclasses", async () => {
  const caps = runInNewContext(`
    delete Promise.withResolvers;
    ${source}
    class SubPromise extends Promise {}
    const resolved = Promise.withResolvers();
    const rejected = SubPromise.withResolvers();
    ({ resolved, rejected, subclass: rejected.promise instanceof SubPromise,
       enumerable: Object.keys(Promise).includes('withResolvers') });
  `);
  caps.resolved.resolve(42);
  await expect(caps.resolved.promise).resolves.toBe(42);
  const rejection = expect(caps.rejected.promise).rejects.toBe("failed");
  caps.rejected.reject("failed");
  await rejection;
  expect(caps.subclass).toBe(true);
  expect(caps.enumerable).toBe(false);
});

test("the compatibility shim preserves an existing native implementation", () => {
  expect(runInNewContext(`
    const native = () => 'native';
    Promise.withResolvers = native;
    ${source}
    Promise.withResolvers === native;
  `)).toBe(true);
});
