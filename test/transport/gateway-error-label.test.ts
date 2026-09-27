/**
 * The public error envelope must name which side failed.
 *
 * A provider rejection and a gateway rejection used to be indistinguishable on
 * the wire: upstream errors were emitted with no prefix at all, so an
 * operator reading a bare message could not tell a rejected credential from a
 * gateway defect, and every unlabelled failure read as ours. These tests pin
 * the label contract — each origin gets its own prefix, and the prefix is
 * applied exactly once.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError, explainGatewayError, labelGatewayMessage } from "../../src/transport/gateway-error";

describe("origin labelling", () => {
  test("an upstream failure is labelled as the upstream's, never the gateway's", () => {
    const error = new GatewayError("authentication_failed", 401, "invalid api key", {}, "upstream");
    const message = explainGatewayError(error);
    expect(message).toBe("Upstream Error: invalid api key");
    expect(message).not.toInclude("Cartethyia");
  });

  test("a gateway failure is labelled as the gateway's", () => {
    const error = new GatewayError("invalid_request", 400, "model is required");
    expect(explainGatewayError(error)).toBe("Cartethyia Error: model is required");
  });

  test("a network failure gets its own label rather than reading as the gateway's", () => {
    const error = new GatewayError("proxy_unreachable", 502, "tunnel refused", {}, "network");
    expect(explainGatewayError(error)).toBe("Network Error: tunnel refused");
  });

  test("the prefix is applied exactly once, however many boundaries it crosses", () => {
    // The ingress normalizer labels the message, then the same value can be
    // re-labelled by a second shaper (the console error handler). Doubling
    // produced "Cartethyia Error: Cartethyia Error: ..." and made the message
    // unreadable, so a labelled message is returned unchanged.
    const once = labelGatewayMessage("cartethyia", "model is required");
    expect(once).toBe("Cartethyia Error: model is required");
    expect(labelGatewayMessage("cartethyia", once)).toBe(once);
    expect(labelGatewayMessage("upstream", once)).toBe(once);
    expect(labelGatewayMessage("network", once)).toBe(once);
  });

  test("an already-labelled upstream message is not re-labelled by another origin", () => {
    const message = labelGatewayMessage("upstream", "quota exhausted");
    expect(message).toBe("Upstream Error: quota exhausted");
    // A later boundary must not overwrite the upstream label with its own.
    expect(labelGatewayMessage("cartethyia", message)).toBe(message);
  });
});
