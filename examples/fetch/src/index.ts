import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { useFlowcesinha } from 'flowcesinha';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	MY_WORKFLOW: Workflow;
	WORKFLOWS_BUCKET: R2Bucket;
};

// User-defined params passed to your workflow
type Params = {
	email: string;
	metadata: Record<string, string>;
};

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		return useFlowcesinha(
			{
				ctx: this.ctx,
				env: this.env,
				event,
				step,
				workflowName: this.constructor.name, // equivalent to writing "MyWorkflow"
			},
			async (event, step) => {
				// test server that 429 4 times, then 200 - see 429.py
				const request = await step.fetch('get example', 'http://localhost:8080');
				console.log('Response from original fetch:', request);

				// Example of using a string for followRetryAfter to specify a custom header name
				// This assumes a server at http://localhost:8081 might return a 429
				// with a header like 'x-custom-retry-duration-seconds: 60'
				const requestWithStringHeader = await step.fetch('get_example_string_header', 'http://localhost:8081', {
					followRetryAfter: 'x-custom-retry-duration-seconds'
				});
				console.log('Response from fetch with string header:', requestWithStringHeader);

				return 'finished example with string header';
			},
		);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get the status of an existing instance, if provided
		const id = url.searchParams.get('instanceId');
		if (id) {
			const instance = await env.MY_WORKFLOW.get(id);
			return Response.json({
				status: await instance.status(),
			});
		}

		// Spawn a new instance and return the ID and status
		const instance = await env.MY_WORKFLOW.create();
		return Response.json({
			id: instance.id,
			details: await instance.status(),
		});
	},
};
