// Side-effect-only import: each retriever self-registers into
// retrieverRegistry on load, same pattern as services/agents/agents/index.ts
// and services/ai/providers/index.ts. Adding a 7th retriever means
// creating the file and adding one more import line here; nothing else
// changes.
import { retrieverRegistry } from '../retriever-registry.js';
import { resourceRetriever } from './resource.retriever.js';
import { graphRetriever } from './graph.retriever.js';
import { findingRetriever } from './finding.retriever.js';
import { policyRetriever } from './policy.retriever.js';
import { recommendationRetriever } from './recommendation.retriever.js';
import { riskRetriever } from './risk.retriever.js';

retrieverRegistry.register(resourceRetriever);
retrieverRegistry.register(graphRetriever);
retrieverRegistry.register(findingRetriever);
retrieverRegistry.register(policyRetriever);
retrieverRegistry.register(recommendationRetriever);
retrieverRegistry.register(riskRetriever);
