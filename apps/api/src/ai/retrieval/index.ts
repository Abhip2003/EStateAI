import { embeddingService } from '../embeddings/index.js';
import { RetrievalService } from './retrieval.service.js';
import { retrievalTelemetry } from './retrieval.telemetry.js';

export { RetrievalService } from './retrieval.service.js';
export type { RetrievalQuery, RetrievalResult, RetrievedDocument } from './retrieval.types.js';

export const retrievalService = new RetrievalService(embeddingService, retrievalTelemetry);
