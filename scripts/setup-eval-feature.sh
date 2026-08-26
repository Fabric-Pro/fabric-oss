#!/bin/bash

# Setup script for EVAL task type feature
# Run this after pulling the branch to ensure all migrations and seeds are applied

set -e  # Exit on error

echo "🚀 Setting up EVAL task type feature..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo -e "${RED}❌ Error: .env.local not found${NC}"
    echo "Please create .env.local with DATABASE_URL and DIRECT_URL"
    exit 1
fi

echo -e "${BLUE}📦 Installing dependencies...${NC}"
pnpm install

echo ""
echo -e "${BLUE}🗄️  Running database migrations...${NC}"
cd packages/database

# Check migration status
echo -e "${YELLOW}Checking migration status...${NC}"
npx dotenv -c -e ../../.env.local -- npx prisma migrate status --schema=./prisma/schema.prisma || true

echo ""
echo -e "${YELLOW}Applying migrations...${NC}"
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --schema=./prisma/schema.prisma

echo ""
echo -e "${BLUE}🔧 Generating Prisma client and Zod schemas...${NC}"
pnpm generate

echo ""
echo -e "${BLUE}🌱 Seeding AI models and task defaults...${NC}"
pnpm seed:ai-models

echo ""
echo -e "${BLUE}🔐 Applying Row-Level Security policies...${NC}"
pnpm apply:rls

echo ""
echo -e "${BLUE}✅ Type checking...${NC}"
cd ../..
pnpm type-check

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Start the development server: ${BLUE}pnpm dev${NC}"
echo "2. Navigate to Settings → AI Models"
echo "3. Configure your EVAL model preference"
echo "4. Generate a document to test evaluations"
echo ""
echo -e "${YELLOW}Verify evaluations are working:${NC}"
echo "- Check document_eval table for evalVersion = 3"
echo "- Look for populated llmProvider, llmModel, and llmScores"
echo "- Verify evalMode = 'hybrid' (if EVAL model configured)"
echo ""
echo -e "${GREEN}🎉 Happy coding!${NC}"
