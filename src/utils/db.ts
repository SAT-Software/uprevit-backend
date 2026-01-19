import { MongoClient, Db, ServerApiVersion } from 'mongodb';

const { MONGODB_URI, DB_NAME } = process.env;

/** Cached database connection instance */
let cachedDb: Db | null = null;

/**
 * Gets a MongoDB database connection.
 * Uses connection pooling and caches the connection across Lambda invocations.
 * @return {Promise<Db>} MongoDB database instance
 * @throws {Error} If MONGODB_URI environment variable is not set or connection fails
 */
export const getDb = async (): Promise<Db> => {
	try {
		if (cachedDb) return cachedDb;

		if (!MONGODB_URI) {
			throw new Error('MONGODB_URI environment variable is not set');
		}

		const client = new MongoClient(MONGODB_URI, {
			serverApi: { version: ServerApiVersion.v1 },
			maxPoolSize: 10,
			maxIdleTimeMS: 60_000,
		});

		await client.connect();
		cachedDb = client.db(DB_NAME);
		console.log('MongoDB connection established');
		return cachedDb;
	} catch (err) {
		console.error('MongoDB connection failed');
		throw err;
	}
};
