import { MongoClient, Db, ServerApiVersion } from 'mongodb';

const { MONGODB_URI, DB_NAME } = process.env;

// One global, lazily initialised client/pool.
let cachedDb: Db | null = null;

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
        console.log('Connected to MongoDB database:', DB_NAME);
        return cachedDb;
    } catch (err) {
        console.error('Error connecting to MongoDB:', err);
        throw err;
    }
};
