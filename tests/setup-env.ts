// Unit tests never touch real services; these values only satisfy config validation.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TREDMAIL_MASTER_ENCRYPTION_KEY ??= "a".repeat(64);
