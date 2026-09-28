/**
 * wire-recorder.ts -- an RPC transport that records exactly what went on the wire.
 *
 * WHY THE WIRE AND NOT THE RETURN VALUE. `SA-C7` is a defect that is invisible from the outside:
 * a caller asked for a read at a pinned block, the helper appended or forwarded the wrong
 * parameter, and the endpoint answered at `latest` instead. The answer is well formed, the call
 * succeeds, nothing throws, and the value is wrong in a way no assertion on the RETURN value can
 * ever see. The only place the defect exists is the request envelope, so that is what this
 * records.
 *
 * A canned answer is supplied per method. Anything unanswered throws rather than returning an
 * empty result, for the same reason the BigQuery simulator refuses unrecognised SQL: a helpful
 * default is how a test starts passing for a reason that has nothing to do with the code.
 */

import type { RpcTransport, RpcTransportResponse } from "../../src/adapters.js";

export interface RecordedCall {
  url: string;
  method: string;
  params: unknown[];
  /** The verbatim request body, so an assertion can look for a literal substring on the wire. */
  body: string;
}

export interface WireRecorder {
  transport: RpcTransport;
  calls: RecordedCall[];
  /** Every call of one JSON-RPC method, in order. */
  of(method: string): RecordedCall[];
}

export interface WireRecorderOptions {
  /**
   * Answer per method. A function receives the params so one method can answer differently per
   * endpoint or per block. Returning `undefined` means "no answer", which throws.
   */
  answers: Record<string, unknown | ((params: unknown[], url: string) => unknown)>;
  /** Endpoints that should fail, mapped to the HTTP status to return. */
  failWith?: Record<string, number>;
}

export function makeWireRecorder(options: WireRecorderOptions): WireRecorder {
  const calls: RecordedCall[] = [];

  const transport: RpcTransport = async (url, init) => {
    const parsed = JSON.parse(init.body) as { method: string; params: unknown[]; id: number };
    calls.push({ url, method: parsed.method, params: parsed.params, body: init.body });

    const status = options.failWith?.[url];
    if (status !== undefined) {
      return respond(status, "simulated endpoint failure");
    }

    const answer = options.answers[parsed.method];
    if (answer === undefined) {
      throw new Error(
        `WIRE_NO_ANSWER: the recorder has no answer for ${parsed.method}. Supply one rather than ` +
        `letting the call fall through, or the test passes for a reason unrelated to the code.`
      );
    }
    const result = typeof answer === "function"
      ? (answer as (p: unknown[], u: string) => unknown)(parsed.params, url)
      : answer;
    return respond(200, JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
  };

  return {
    transport,
    calls,
    of: (method: string) => calls.filter((c) => c.method === method),
  };
}

function respond(status: number, text: string): RpcTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}
