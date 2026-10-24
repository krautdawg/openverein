import { readFileSync } from 'node:fs';
import { XmlDocument, XsdValidator } from 'libxml2-wasm';

const xsd = (name: string) => readFileSync(new URL(`./xsd/${name}.xsd`, import.meta.url), 'utf8');
const validators = new Map<string, XsdValidator>();

/** Validates a generated SEPA file against the official ISO 20022 schema; throws with libxml2's messages. */
export function validateSepa(xml: string, schema: 'pain.008.001.08' | 'pain.001.001.09') {
  let v = validators.get(schema);
  if (!v) {
    v = XsdValidator.fromDoc(XmlDocument.fromString(xsd(schema)));
    validators.set(schema, v);
  }
  const doc = XmlDocument.fromString(xml);
  try {
    v.validate(doc);
  } finally {
    doc.dispose();
  }
}
