output "budget_names" {
  description = "List of created budget names"
  value       = [for b in aws_budgets_budget.monthly : b.name]
}
