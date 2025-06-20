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
				const request = await step.fetch('get example', 'http://localhost:8080', {
					followRetryAfter: (headers: Headers) => {
						const retries: number[] = [];
						const AzureRetryHeader = new RegExp(/^x-ms-ratelimit-\w+-retry-after$/i);

						for (const [key, value] of headers.entries()) {
							if (AzureRetryHeader.test(key)) {
								retries.push(parseInt(value));
							}
						}

						const retryAfter: number | undefined = retries.sort((a, b) => a - b)[0];
						if (retryAfter) {
							return new Date(new Date().valueOf() + (retryAfter * 1000));
						} else {
							throw new Error('No retry-after header found');
						}
					},
				});

				console.log(request);

				return 'finished';
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
