import type { components } from './generated/ai-service';

/**
 * The AI service contract. These types are GENERATED from the OpenAPI document
 * (`packages/contracts/openapi/ai-service.json`, exported from the Pydantic models by
 * `make contracts`): never write them by hand.
 */
export type ProcessRequest = components['schemas']['ProcessRequest'];
export type ProcessResponse = components['schemas']['ProcessResponse'];
export type ProcessReply = components['schemas']['Reply'];
export type ProcessReplyButton = components['schemas']['ReplyButton'];
export type ProcessMeta = components['schemas']['Meta'];
export type ProcessIntent = components['schemas']['Intent'];
export type ProcessInputType = components['schemas']['InputType'];
export type GenericDetailsRequest = components['schemas']['GenericDetailsRequest'];
export type GenericDetailsResponse = components['schemas']['GenericDetailsResponse'];
export type GenericSuggestion = components['schemas']['GenericSuggestion'];
export type InteractionReport = components['schemas']['InteractionReport'];
export type InteractionFinding = components['schemas']['InteractionFinding'];
export type InteractionCheckRequest = components['schemas']['InteractionCheckRequest'];
export type InteractionCheckResponse = components['schemas']['InteractionCheckResponse'];
export type InteractionDetailsRequest = components['schemas']['InteractionDetailsRequest'];
export type InteractionDetailsResponse = components['schemas']['InteractionDetailsResponse'];
export type ActiveMedicationContext = components['schemas']['ActiveMedication'];
