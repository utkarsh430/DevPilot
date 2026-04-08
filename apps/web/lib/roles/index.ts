// Phase 0 + M4/M6/M7 built-in roles.
import { engineerRole } from "@/lib/roles/engineer";
import { pmRole } from "@/lib/roles/pm";
import { qaRole } from "@/lib/roles/qa";
import { devopsRole } from "@/lib/roles/devops";
import { techWriterRole } from "@/lib/roles/techwriter";
import { designerRole } from "@/lib/roles/designer";
import { dataEngineerRole } from "@/lib/roles/dataeng";
import { securityRole } from "@/lib/roles/security";
import { triageRole } from "@/lib/roles/triage";
import { techLeadRole } from "@/lib/roles/tech_lead";

// Phase 2 — Leadership / Product.
import { ctoRole } from "@/lib/roles/cto";
import { vpEngineeringRole } from "@/lib/roles/vp_engineering";
import { productManagerRole } from "@/lib/roles/product_manager";
import { technicalProductManagerRole } from "@/lib/roles/technical_product_manager";
import { productOwnerRole } from "@/lib/roles/product_owner";
import { engineeringManagerRole } from "@/lib/roles/engineering_manager";

// Phase 2 — Engineering specialists.
import { frontendEngineerRole } from "@/lib/roles/frontend_engineer";
import { backendEngineerRole } from "@/lib/roles/backend_engineer";
import { fullstackEngineerRole } from "@/lib/roles/fullstack_engineer";
import { mobileEngineerRole } from "@/lib/roles/mobile_engineer";
import { staffEngineerRole } from "@/lib/roles/staff_engineer";
import { softwareArchitectRole } from "@/lib/roles/software_architect";

// Phase 2 — Data.
import { dataScientistRole } from "@/lib/roles/data_scientist";
import { dataAnalystRole } from "@/lib/roles/data_analyst";
import { mlEngineerRole } from "@/lib/roles/ml_engineer";
import { analyticsEngineerRole } from "@/lib/roles/analytics_engineer";

// Phase 2 — Infrastructure / Ops.
import { sreRole } from "@/lib/roles/sre";
import { cloudEngineerRole } from "@/lib/roles/cloud_engineer";
import { platformEngineerRole } from "@/lib/roles/platform_engineer";
import { dbaRole } from "@/lib/roles/dba";

// Phase 2 — Quality + Security.
import { qaAutomationEngineerRole } from "@/lib/roles/qa_automation_engineer";
import { sdetRole } from "@/lib/roles/sdet";
import { securityEngineerRole } from "@/lib/roles/security_engineer";
import { appSecEngineerRole } from "@/lib/roles/appsec_engineer";
import { complianceGrcRole } from "@/lib/roles/compliance_grc";

// Phase 2 — Design specialists.
import { uxDesignerRole } from "@/lib/roles/ux_designer";
import { uiDesignerRole } from "@/lib/roles/ui_designer";
import { uxResearcherRole } from "@/lib/roles/ux_researcher";
import { productDesignerRole } from "@/lib/roles/product_designer";

// Phase 2 — Go-to-Market / Customer.
import { salesAccountExecutiveRole } from "@/lib/roles/sales_account_executive";
import { solutionsEngineerRole } from "@/lib/roles/solutions_engineer";
import { customerSuccessManagerRole } from "@/lib/roles/customer_success_manager";
import { implementationSpecialistRole } from "@/lib/roles/implementation_specialist";
import { technicalSupportEngineerRole } from "@/lib/roles/technical_support_engineer";
import { marketingManagerRole } from "@/lib/roles/marketing_manager";

// Phase 2 — Operations / Support.
import { projectProgramManagerRole } from "@/lib/roles/project_program_manager";
import { scrumMasterRole } from "@/lib/roles/scrum_master";
import { businessAnalystRole } from "@/lib/roles/business_analyst";
import { itAdminRole } from "@/lib/roles/it_admin";

// Phase 2 / M5b — Project scaffolder.
import { projectScaffolderRole } from "@/lib/roles/project_scaffolder";

// Phase 2 / F5 — final-gate verifier (post-QA build/smoke-check).
import { verifierRole } from "@/lib/roles/verifier";

// Phase 2.5+ / Slice IB-B — auto-spawned merge-conflict resolver.
import { releaseEngineerRole } from "@/lib/roles/release_engineer";

import type { Role, RoleConfig } from "@/lib/roles/types";

export const ROLES: Record<Role, RoleConfig> = {
  // Phase 0 + M4 + M6 + M7
  pm: pmRole,
  engineer: engineerRole,
  qa: qaRole,
  devops: devopsRole,
  techwriter: techWriterRole,
  designer: designerRole,
  dataeng: dataEngineerRole,
  security: securityRole,
  triage: triageRole,
  tech_lead: techLeadRole,
  // Phase 2 — Leadership / Product
  cto: ctoRole,
  vp_engineering: vpEngineeringRole,
  product_manager: productManagerRole,
  technical_product_manager: technicalProductManagerRole,
  product_owner: productOwnerRole,
  engineering_manager: engineeringManagerRole,
  // Phase 2 — Engineering specialists
  frontend_engineer: frontendEngineerRole,
  backend_engineer: backendEngineerRole,
  fullstack_engineer: fullstackEngineerRole,
  mobile_engineer: mobileEngineerRole,
  staff_engineer: staffEngineerRole,
  software_architect: softwareArchitectRole,
  // Phase 2 — Data
  data_scientist: dataScientistRole,
  data_analyst: dataAnalystRole,
  ml_engineer: mlEngineerRole,
  analytics_engineer: analyticsEngineerRole,
  // Phase 2 — Infrastructure / Ops
  sre: sreRole,
  cloud_engineer: cloudEngineerRole,
  platform_engineer: platformEngineerRole,
  dba: dbaRole,
  // Phase 2 — Quality + Security
  qa_automation_engineer: qaAutomationEngineerRole,
  sdet: sdetRole,
  security_engineer: securityEngineerRole,
  appsec_engineer: appSecEngineerRole,
  compliance_grc: complianceGrcRole,
  // Phase 2 — Design specialists
  ux_designer: uxDesignerRole,
  ui_designer: uiDesignerRole,
  ux_researcher: uxResearcherRole,
  product_designer: productDesignerRole,
  // Phase 2 — Go-to-Market / Customer
  sales_account_executive: salesAccountExecutiveRole,
  solutions_engineer: solutionsEngineerRole,
  customer_success_manager: customerSuccessManagerRole,
  implementation_specialist: implementationSpecialistRole,
  technical_support_engineer: technicalSupportEngineerRole,
  marketing_manager: marketingManagerRole,
  // Phase 2 — Operations / Support
  project_program_manager: projectProgramManagerRole,
  scrum_master: scrumMasterRole,
  business_analyst: businessAnalystRole,
  it_admin: itAdminRole,
  // Phase 2 / M5b — Project scaffolder
  project_scaffolder: projectScaffolderRole,
  // Phase 2 / F5 — Verifier (final build/smoke-check gate after QA)
  verifier: verifierRole,
  // Phase 2.5+ / Slice IB-B — Release Engineer (auto-spawned merge-conflict resolver)
  release_engineer: releaseEngineerRole,
};

export type { Role, RoleConfig } from "@/lib/roles/types";
