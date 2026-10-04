// pdf.js 6 no longer supplies this polyfill. iOS 17.0 through 17.3 need it
// in both the page and the module worker, before either pdf.js module runs.
if (typeof Promise.withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: function withResolvers() {
      let resolve, reject;
      const promise = new this((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}
