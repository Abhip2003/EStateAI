// Side-effect-only import: each policy file self-registers into
// policyRegistry on load, same pattern as services/analysis/rules/index.ts.
// Adding a new provider's policies means creating the files and adding one
// more import line here; nothing else changes.
import './github/no-public-repositories.policy.js';
import './github/repositories-must-have-description.policy.js';
import './github/repositories-must-have-topics.policy.js';
import './github/archived-repositories-are-allowed.policy.js';
import './github/fork-repositories-ignored.policy.js';
