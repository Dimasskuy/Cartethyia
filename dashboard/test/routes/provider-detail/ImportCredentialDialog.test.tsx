/**
 * The flow-field helpers behind every OAuth prompt.
 *
 * These decide what a flow asks for and whether it may start, so the properties
 * worth pinning are the ones that otherwise only fail against a live provider:
 * a declared default is applied rather than left blank, a required field with no
 * value blocks the start instead of being sent as an empty string, and an
 * optional field left empty is not treated as missing.
 */
import { describe, expect, test } from "bun:test";
import {
  initialFieldValues,
  missingRequiredFields,
  type LoginField,
} from "../../../src/routes/provider-detail/ImportCredentialDialog";

const FIELDS: readonly LoginField[] = [
  { key: "authMethod", label: "Sign-in method", required: true, defaultValue: "builder-id" },
  { key: "region", label: "AWS region", required: true, defaultValue: "us-east-1" },
  { key: "startUrl", label: "Organization start URL" },
  { key: "clientSecret", label: "Client secret", secret: true },
];

describe("initialFieldValues", () => {
  test("applies each declared default", () => {
    expect(initialFieldValues(FIELDS)).toEqual({
      authMethod: "builder-id",
      region: "us-east-1",
      startUrl: "",
      clientSecret: "",
    });
  });

  test("leaves a field with no default empty rather than absent", () => {
    // Absent would be indistinguishable from "the provider declared no such
    // field", and the form would not render an input for it.
    expect(initialFieldValues(FIELDS)).toHaveProperty("startUrl");
  });

  test("returns nothing for a flow that declares no fields", () => {
    expect(initialFieldValues([])).toEqual({});
  });
});

describe("missingRequiredFields", () => {
  test("reports a required field the operator cleared", () => {
    const values = { ...initialFieldValues(FIELDS), region: "" };
    expect(missingRequiredFields(FIELDS, values)).toEqual(["region"]);
  });

  test("accepts a field set whose required values are all present", () => {
    expect(missingRequiredFields(FIELDS, initialFieldValues(FIELDS))).toEqual([]);
  });

  test("does not treat an empty optional field as missing", () => {
    // startUrl and clientSecret are optional; a blank one is a valid choice.
    expect(missingRequiredFields(FIELDS, initialFieldValues(FIELDS))).not.toContain("startUrl");
    expect(missingRequiredFields(FIELDS, initialFieldValues(FIELDS))).not.toContain("clientSecret");
  });

  test("treats whitespace as empty", () => {
    const values = { ...initialFieldValues(FIELDS), authMethod: "   " };
    expect(missingRequiredFields(FIELDS, values)).toEqual(["authMethod"]);
  });

  test("reports a required field the values object never mentioned", () => {
    expect(missingRequiredFields(FIELDS, {})).toEqual(["authMethod", "region"]);
  });
});
