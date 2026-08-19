import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto,
});

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: globalThis,
});
