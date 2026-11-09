// Some NEAR wallet libraries expect Node's Buffer/global in the browser.
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.global = globalThis.global || globalThis;
globalThis.process = globalThis.process || { env: {} };
