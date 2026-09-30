// Preloaded by bunfig.toml before every test file.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-0123456789";
process.env.CORS_ORIGINS ??= "http://localhost:5173";
process.env.TEST_DATABASE_URL ??= "postgres://mafaaza:mafaaza@localhost:5433/mafaaza_test";
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
