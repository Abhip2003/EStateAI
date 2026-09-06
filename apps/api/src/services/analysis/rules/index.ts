// Side-effect-only import: each rule file self-registers into ruleRegistry
// on load. Importing this module (from finding.service.ts) is what makes
// the rule set active — RuleEngine itself never imports a provider's rule
// files directly. Adding a new provider's rules means creating the files
// and adding one more import line here; nothing else changes.
import './github/public-repository.rule.js';
import './github/archived-repository.rule.js';
import './github/empty-repository.rule.js';
import './github/missing-description.rule.js';
import './github/missing-topics.rule.js';
