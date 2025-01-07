export abstract class StorageEngineBase {
	abstract get<T>(key: string, type: ResultType): Promise<T | undefined>;
	abstract getStream(
		key: string,
	): Promise<ReadableStream<Uint8Array> | undefined>;
	abstract set<T>(key: string, value: T, type: ResultType): Promise<T>;
	abstract exists(key: string): Promise<boolean>;
}

export type ResultType = "response" | "arrayBuffer" | "readableStream" | "json";

/**
 * Result of a Get operation in a storage engine. This makes custom storage operations lazy in their result, useful if your results can
 * take more than the returned step limit and occupy a bit of memory.
 */
export class Result<T, StorageEngine extends StorageEngineBase> {
	constructor(
		private engine: StorageEngine,
		public readonly key: string,
		public readonly type: ResultType,
	) {}

	async getBlob(): Promise<ReadableStream<Uint8Array> | undefined> {
		return await this.engine.getStream(this.key);
	}

	async getFull(): Promise<T | undefined> {
		return await this.engine.get(this.key, this.type);
	}
}

/**
 * Storage engine that uses R2 to store data.
 * It usually does 1 read and 1 write operation per get/set operation, except for responses that it must store the headers separately, so it does 2 read/writes.
 */
export class R2Storage extends StorageEngineBase {
	constructor(private storage: R2Bucket) {
		super();
	}

	async get<T>(key: string, resultType: ResultType): Promise<T | undefined> {
		const value = await this.storage.get(key);
		if (value === null) {
			return undefined;
		}
		switch (resultType) {
			case "response": {
				const headers = await this.storage.get(key + "-headers");
				if (headers === null) {
					throw new Error("Headers not found for response");
				}
				const {
					status,
					statusText,
					headers: rawHeaders,
				} = JSON.parse(await headers.json());
				const responseHeaders = new Headers(rawHeaders);
				return new Response(value.body, {
					status,
					statusText,
					headers: responseHeaders,
				}) as T;
			}

			case "arrayBuffer":
				return (await value.arrayBuffer()) as T;
			case "readableStream":
				return value.body as T;
			case "json":
				return JSON.parse(await value.json());
		}
	}

	async getStream(
		key: string,
	): Promise<ReadableStream<Uint8Array> | undefined> {
		const value = await this.storage.get(key);
		if (value === null) {
			return undefined;
		}
		return value.body;
	}

	async set<T>(key: string, value: T, resultType: ResultType): Promise<T> {
		switch (resultType) {
			case "response": {
				console.log("response", value);
				const response = value as Response;
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key] = value;
				});
				if (response.headers.get("content-length") == null) {
					// NOTE(lduarte): if response does not provide content-length, we cannot pass the readablestream directly to R2 and
					// therefore we have to read it first to memory and then store it (which can cause OoM errors)
					await this.storage.put(key, await response.arrayBuffer());
				} else {
					await this.storage.put(key, response.body);
				}
				await this.storage.put(
					key + "-headers",
					JSON.stringify({
						status: response.status,
						statusText: response.statusText,
						headers,
					}),
				);
				break;
			}
			case "arrayBuffer":
			case "readableStream":
				await this.storage.put(key, value as ReadableStream<Uint8Array>);
				break;
			case "json":
				await this.storage.put(key, JSON.stringify(value));
				break;
		}

		return value;
	}

	async exists(key: string): Promise<boolean> {
		return (await this.storage.get(key)) !== null;
	}
}
