/**
 * Extraction prompts for entity and relation extraction.
 * Kept in a separate file for easy iteration.
 */

export const ENTITY_EXTRACTION_PROMPT = `You are an entity extraction system for project documentation. Analyze the given text chunk and extract structured entities.

Extract entities of these types:
- decision: A choice made or proposed (e.g., tool selection, process change, strategic direction)
- dependency: Something this workflow or process depends on (e.g., another system, team, data source, approval)
- gap: A missing capability, unknown, or unresolved question (often marked with [GAP] in the text)
- stakeholder: A person or team mentioned as responsible, involved, or impacted
- milestone: A target date, deliverable, or phase gate
- workflow: A named process, pipeline, or operational workflow

For each entity, provide:
- entity_type: one of the six types above
- content: the extracted text describing the entity (keep it concise, 1-2 sentences max)
- status: "open", "resolved", "blocked", or "unknown"
- owner: stakeholder name if identifiable, otherwise null
- confidence: 0.0 to 1.0 indicating extraction confidence

Return ONLY a JSON object with this exact structure, no other text:
{"entities": [{"entity_type": "...", "content": "...", "status": "...", "owner": null, "confidence": 0.9}]}

If no entities are found, return: {"entities": []}

Examples:

Input: "The team decided to migrate from REST to GraphQL for better query flexibility. Sarah Chen will lead the migration effort."
Output: {"entities": [{"entity_type": "decision", "content": "Team decided to migrate from REST to GraphQL for better query flexibility", "status": "open", "owner": "Sarah Chen", "confidence": 0.85}, {"entity_type": "stakeholder", "content": "Sarah Chen — leading the REST to GraphQL migration", "status": "unknown", "owner": null, "confidence": 0.95}]}

Input: "[GAP] Who owns the authentication service migration? What is the timeline for the API v2 rollout?"
Output: {"entities": [{"entity_type": "gap", "content": "Unknown owner of authentication service migration", "status": "open", "owner": null, "confidence": 0.95}, {"entity_type": "gap", "content": "Timeline for API v2 rollout is undefined", "status": "open", "owner": null, "confidence": 0.9}]}

Input: "The deployment pipeline requires the CI/CD system to pass all integration tests. This depends on the staging environment being available and the database migration scripts being validated."
Output: {"entities": [{"entity_type": "workflow", "content": "Deployment pipeline — requires CI/CD integration tests to pass before deployment", "status": "open", "owner": null, "confidence": 0.9}, {"entity_type": "dependency", "content": "Requires staging environment availability for deployment pipeline", "status": "unknown", "owner": null, "confidence": 0.85}, {"entity_type": "dependency", "content": "Requires validated database migration scripts for deployment", "status": "unknown", "owner": null, "confidence": 0.85}]}

Now extract entities from this text:
`;

export const RELATION_EXTRACTION_PROMPT = `You are a relation extraction system. Given a list of entities extracted from a project document, identify relationships between them.

Relation types:
- blocks: entity A blocks entity B (e.g., a gap blocking a milestone)
- owns: entity A owns/is responsible for entity B (e.g., stakeholder owns a workflow)
- references: entity A references entity B (e.g., a decision references a dependency)
- supersedes: entity A replaces or supersedes entity B

For each relation, provide:
- source_index: index of the source entity in the provided list (0-based)
- target_index: index of the target entity in the provided list (0-based)
- relation_type: one of the four types above
- confidence: 0.0 to 1.0

Return ONLY a JSON object with this exact structure, no other text:
{"relations": [{"source_index": 0, "target_index": 1, "relation_type": "owns", "confidence": 0.8}]}

If no relations are found, return: {"relations": []}

Here are the entities to analyze:
`;
