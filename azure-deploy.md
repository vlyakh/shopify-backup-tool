# Deploying Shopify Backup App to Azure

This guide covers deploying the app to Azure App Service with PostgreSQL and Blob Storage.

## Prerequisites

- Azure CLI installed (`az` command) and logged in
- GitHub repo with the code pushed to `main`
- Shopify app credentials from Partners dashboard

## 1. Create a Resource Group

```bash
az group create --name shopify-backup-rg --location eastus
```

## 2. Create Azure Database for PostgreSQL Flexible Server

```bash
az postgres flexible-server create \
  --resource-group shopify-backup-rg \
  --name shopify-backup-db \
  --location eastus \
  --admin-user shopifyadmin \
  --admin-password '<strong-password>' \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --yes

# Create the database
az postgres flexible-server db create \
  --resource-group shopify-backup-rg \
  --server-name shopify-backup-db \
  --database-name shopify_backup
```

Your connection string will be:
```
postgresql://shopifyadmin:<password>@shopify-backup-db.postgres.database.azure.com:5432/shopify_backup?sslmode=require
```

## 3. Create Azure Blob Storage

```bash
az storage account create \
  --name devsimplerfid \
  --resource-group shopify-backup-rg \
  --location eastus \
  --sku Standard_LRS

az storage container create \
  --name shopify-backups \
  --account-name devsimplerfid
```

Get the connection string:
```bash
az storage account show-connection-string \
  --name devsimplerfid \
  --resource-group shopify-backup-rg \
  --query connectionString -o tsv
```

## 4. Create Azure App Service

```bash
# Create the App Service plan (B1 is the cheapest plan that supports always-on)
az appservice plan create \
  --name shopify-backup-plan \
  --resource-group shopify-backup-rg \
  --sku B1 \
  --is-linux

# Create the web app
az webapp create \
  --resource-group shopify-backup-rg \
  --plan shopify-backup-plan \
  --name shopify-backup-app \
  --runtime "NODE:22-lts"
```

## 5. Configure Environment Variables

```bash
az webapp config appsettings set \
  --resource-group shopify-backup-rg \
  --name shopify-backup-app \
  --settings \
    DATABASE_URL="postgresql://shopifyadmin:<password>@shopify-backup-db.postgres.database.azure.com:5432/shopify_backup?sslmode=require" \
    SHOPIFY_API_KEY="<your-api-key>" \
    SHOPIFY_API_SECRET="<your-api-secret>" \
    SCOPES="read_products,write_products,read_content,read_themes,read_online_store_navigation,read_online_store_pages,read_publications,read_script_tags,read_inventory,read_price_rules,read_discounts,read_metaobjects,read_metaobject_definitions" \
    SHOPIFY_APP_URL="https://shopify-backup-app.azurewebsites.net" \
    STORAGE_PROVIDER="azure" \
    AZURE_STORAGE_CONNECTION_STRING="<blob-connection-string>" \
    AZURE_STORAGE_CONTAINER="shopify-backups" \
    NODE_ENV="production"
```

Set the startup command:
```bash
az webapp config set \
  --resource-group shopify-backup-rg \
  --name shopify-backup-app \
  --startup-file "startup.sh"
```

## 6. Set Up GitHub Actions Deployment

### Create an Azure Service Principal

```bash
az ad sp create-for-rbac \
  --name "shopify-backup-deploy" \
  --role contributor \
  --scopes /subscriptions/<subscription-id>/resourceGroups/shopify-backup-rg \
  --sdk-auth
```

Copy the JSON output.

### Add GitHub Secrets

In your GitHub repo, go to **Settings > Secrets and variables > Actions** and add:

| Secret | Value |
|---|---|
| `AZURE_CREDENTIALS` | The full JSON from the service principal command |
| `AZURE_WEBAPP_NAME` | `shopify-backup-app` |

Push to `main` and the workflow will deploy automatically.

## 7. Run Migrations Manually (First Time)

The startup script runs `prisma migrate deploy` automatically on every start. For the very first deployment, you can verify it worked by checking the logs:

```bash
az webapp log tail \
  --resource-group shopify-backup-rg \
  --name shopify-backup-app
```

## 8. Allow App Service to Reach PostgreSQL

By default, the PostgreSQL flexible server blocks external access. Allow Azure services:

```bash
az postgres flexible-server firewall-rule create \
  --resource-group shopify-backup-rg \
  --name shopify-backup-db \
  --rule-name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

For better security, use VNet integration instead of the firewall rule above. See [Azure VNet integration docs](https://learn.microsoft.com/en-us/azure/app-service/overview-vnet-integration).

## Useful Commands

```bash
# View live logs
az webapp log tail --resource-group shopify-backup-rg --name shopify-backup-app

# Restart the app
az webapp restart --resource-group shopify-backup-rg --name shopify-backup-app

# SSH into the container
az webapp ssh --resource-group shopify-backup-rg --name shopify-backup-app

# Check app status
az webapp show --resource-group shopify-backup-rg --name shopify-backup-app --query state -o tsv
```

## Running Locally with Docker

```bash
# Copy .env.example to .env and fill in your values
cp .env.example .env

# Start the app and database
docker compose up --build

# The app will be at http://localhost:3000
# PostgreSQL will be at localhost:5432
```

## Cost Estimate (Monthly)

| Resource | SKU | Approx. Cost |
|---|---|---|
| App Service | B1 (1 core, 1.75 GB) | ~$13 |
| PostgreSQL Flexible | Burstable B1ms | ~$12 |
| Blob Storage | Standard LRS | ~$1 (depends on usage) |
| **Total** | | **~$26/month** |

You can scale up the App Service plan and PostgreSQL tier as your usage grows.
