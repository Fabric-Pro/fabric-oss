#!/usr/bin/env bash
# Deployment utilities and helper functions for Fabric Portal
# This file provides common functions used by deployment scripts

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[0;37m'
NC='\033[0m' # No Color

# Utility functions
log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_debug() { echo -e "${PURPLE}[DEBUG]${NC} $*"; }
log_header() { echo -e "${CYAN}=== $* ===${NC}"; }

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if a port is in use
check_port() {
    local port=$1
    if lsof -i ":$port" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Wait for a service to be ready
wait_for_service() {
    local url=$1
    local service_name=$2
    local max_attempts=${3:-30}
    local attempt=0
    
    log_info "Waiting for $service_name to be ready..."
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s -f "$url" >/dev/null 2>&1; then
            log_success "$service_name is ready!"
            return 0
        fi
        
        attempt=$((attempt + 1))
        log_info "Waiting for $service_name... (attempt $attempt/$max_attempts)"
        sleep 5
    done
    
    log_error "$service_name is not ready after $max_attempts attempts"
    return 1
}

# Test database connection
test_database_connection() {
    local db_url=$1
    local timeout=${2:-10}
    
    if command_exists psql; then
        if timeout "$timeout" psql "$db_url" -c "SELECT 1;" >/dev/null 2>&1; then
            return 0
        else
            return 1
        fi
    else
        log_warning "psql not available, skipping database connection test"
        return 0
    fi
}

# Generate random string
generate_random_string() {
    local length=${1:-32}
    openssl rand -hex $((length / 2)) 2>/dev/null || date | md5sum | head -c $length
}

# Validate environment variables
validate_env_vars() {
    local env_file=$1
    local required_vars=("$@")
    shift
    
    local missing_vars=()
    
    for var in "${required_vars[@]}"; do
        if ! grep -q "^$var=" "$env_file" 2>/dev/null || [ -z "$(grep "^$var=" "$env_file" | cut -d= -f2-)" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_error "Missing required environment variables: ${missing_vars[*]}"
        return 1
    fi
    
    return 0
}

# Check service health
check_service_health() {
    local service_name=$1
    local health_url=$2
    local expected_status=${3:-200}
    
    if curl -s -f -w "%{http_code}" "$health_url" | grep -q "^$expected_status"; then
        log_success "$service_name health check passed"
        return 0
    else
        log_error "$service_name health check failed"
        return 1
    fi
}

# Get public IP
get_public_ip() {
    if command_exists curl; then
        curl -s https://api.ipify.org || echo "unknown"
    else
        echo "unknown"
    fi
}

# Check if running in CI/CD
check_ci_environment() {
    if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${GITLAB_CI:-}" ]; then
        return 0
    else
        return 1
    fi
}

# Get system info
get_system_info() {
    local os=$(uname -s)
    local arch=$(uname -m)
    local node_version=$(node --version 2>/dev/null || echo "unknown")
    local npm_version=$(npm --version 2>/dev/null || echo "unknown")
    
    echo "OS: $os"
    echo "Architecture: $arch"
    echo "Node.js: $node_version"
    echo "npm: $npm_version"
}

# Backup file with timestamp
backup_file() {
    local file=$1
    local backup_suffix=${2:-"$(date +%Y%m%d_%H%M%S)"}
    
    if [ -f "$file" ]; then
        cp "$file" "${file}.backup.${backup_suffix}"
        log_info "Backed up $file to ${file}.backup.${backup_suffix}"
    fi
}

# Restore file from backup
restore_file() {
    local file=$1
    local backup_pattern=${2:-"*.backup.*"}
    
    local latest_backup=$(ls -t ${file}.backup.* 2>/dev/null | head -n1)
    if [ -n "$latest_backup" ]; then
        cp "$latest_backup" "$file"
        log_info "Restored $file from $latest_backup"
    else
        log_error "No backup found for $file"
        return 1
    fi
}

# Compare semantic versions
compare_versions() {
    local version1=$1
    local version2=$2
    
    if [ "$(printf '%s\n' "$version1" "$version2" | sort -V | head -n1)" = "$version1" ]; then
        echo "less"
    elif [ "$version1" = "$version2" ]; then
        echo "equal"
    else
        echo "greater"
    fi
}

# Check if version meets minimum requirement
check_min_version() {
    local current_version=$1
    local min_version=$2
    
    local comparison=$(compare_versions "$current_version" "$min_version")
    
    if [ "$comparison" = "less" ]; then
        return 1
    else
        return 0
    fi
}

# Get memory usage
get_memory_usage() {
    if command_exists free; then
        free -h | grep "Mem:" | awk '{print $3 "/" $2}'
    elif [ -f /proc/meminfo ]; then
        local total=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        local available=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
        local used=$((total - available))
        echo "$(echo "scale=1; $used/1024" | bc)M/$(echo "scale=1; $total/1024" | bc)M"
    else
        echo "unknown"
    fi
}

# Get disk usage
get_disk_usage() {
    local path=${1:-"/"}
    df -h "$path" | tail -n1 | awk '{print $3 "/" $2 " (" $5 ")"}'
}

# Check if service is running
check_service_running() {
    local service_name=$1
    
    if systemctl is-active --quiet "$service_name" 2>/dev/null; then
        return 0
    elif pgrep -f "$service_name" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Restart service
restart_service() {
    local service_name=$1
    
    if systemctl restart "$service_name" 2>/dev/null; then
        log_success "$service_name restarted successfully"
        return 0
    else
        log_error "Failed to restart $service_name"
        return 1
    fi
}

# Get SSL certificate expiration
check_ssl_expiration() {
    local domain=$1
    local days_warning=${2:-30}
    
    if command_exists openssl; then
        local expiration_date=$(echo | openssl s_client -servername "$domain" -connect "$domain:443" 2>/dev/null | openssl x509 -noout -dates | grep 'notAfter' | cut -d= -f2)
        if [ -n "$expiration_date" ]; then
            local expiration_timestamp=$(date -d "$expiration_date" +%s)
            local current_timestamp=$(date +%s)
            local days_until_expiration=$(( (expiration_timestamp - current_timestamp) / 86400 ))
            
            if [ $days_until_expiration -lt $days_warning ]; then
                log_warning "SSL certificate for $domain expires in $days_until_expiration days"
                return 1
            else
                log_success "SSL certificate for $domain expires in $days_until_expiration days"
                return 0
            fi
        fi
    fi
    
    log_warning "Could not check SSL certificate for $domain"
    return 1
}

# Send notification (placeholder for actual implementation)
send_notification() {
    local message=$1
    local severity=${2:-"info"}
    
    # This is a placeholder - implement your notification service here
    # Examples: Slack, Discord, email, etc.
    
    case "$severity" in
        "error")
            log_error "NOTIFICATION: $message"
            ;;
        "warning")
            log_warning "NOTIFICATION: $message"
            ;;
        "success")
            log_success "NOTIFICATION: $message"
            ;;
        *)
            log_info "NOTIFICATION: $message"
            ;;
    esac
}

# Cleanup old backups
cleanup_backups() {
    local backup_dir=${1:-"."}
    local max_age_days=${2:-30}
    
    find "$backup_dir" -name "*.backup.*" -type f -mtime +$max_age_days -delete 2>/dev/null || true
    log_info "Cleaned up backups older than $max_age_days days"
}

# Get deployment timestamp
get_deployment_timestamp() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Save deployment info
save_deployment_info() {
    local environment=$1
    local version=$2
    local status=$3
    local deployment_file=".deployment-info.json"
    
    cat > "$deployment_file" << EOF
{
  "environment": "$environment",
  "version": "$version",
  "status": "$status",
  "timestamp": "$(get_deployment_timestamp)",
  "git_commit": "$(git rev-parse HEAD 2>/dev/null || echo "unknown")",
  "git_branch": "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")",
  "system_info": {
    "os": "$(uname -s)",
    "arch": "$(uname -m)",
    "node_version": "$(node --version 2>/dev/null || echo "unknown")",
    "npm_version": "$(npm --version 2>/dev/null || echo "unknown")"
  }
}
EOF
    
    log_info "Deployment info saved to $deployment_file"
}

# Load deployment info
load_deployment_info() {
    local deployment_file=".deployment-info.json"
    
    if [ -f "$deployment_file" ]; then
        cat "$deployment_file"
    else
        echo "{}"
    fi
}

# Export functions for use in other scripts
export -f log_info log_success log_warning log_error log_debug log_header
export -f command_exists check_port wait_for_service test_database_connection
export -f generate_random_string validate_env_vars check_service_health
export -f get_public_ip check_ci_environment get_system_info
export -f backup_file restore_file compare_versions check_min_version
export -f get_memory_usage get_disk_usage check_service_running restart_service
export -f check_ssl_expiration send_notification cleanup_backups
export -f get_deployment_timestamp save_deployment_info load_deployment_info