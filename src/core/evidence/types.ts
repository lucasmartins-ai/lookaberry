export type EvidenceClassification =
  | 'FACT'
  | 'INFERENCE'
  | 'LLM_INFERENCE'
  | 'USER_PROVIDED'
  | 'UNVERIFIED';

type JsonPrimitive = string | number | boolean | null;
export type SanitizedJson = JsonPrimitive | SanitizedJson[] | { [key: string]: SanitizedJson };
