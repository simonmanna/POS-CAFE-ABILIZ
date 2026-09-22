import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../kernel/auth/decorators/require-permissions.decorator';
import { HrOrgService } from './hr-org.service';
import { HrAccessService } from './hr-access.service';
import { HrLifecycleService } from './hr-lifecycle.service';
import { HrSelfService } from './hr-self.service';
import { HrDocumentsService } from './hr-documents.service';
import { HrAnalyticsService } from './hr-analytics.service';
import { LinkUserDto, ProvisionUserDto } from './dto/hr-access.dto';
import { SetPinDto } from '../../kernel/auth/staff/users/dto/set-pin.dto';
import {
  ConfirmEmployeeDto,
  ReactivateEmployeeDto,
  SuspendEmployeeDto,
  TerminateEmployeeDto,
  TransferEmployeeDto,
  UpdateAccessDto,
} from './dto/hr-lifecycle.dto';
import { HrAttendanceService } from './hr-attendance.service';
import { HrTimesheetService } from './hr-timesheet.service';
import { HrLeaveService } from './hr-leave.service';
import { HrPayrollService } from './hr-payroll.service';
import { HrReportsService } from './hr-reports.service';
import { RequiresModule } from '../../kernel/module-loader/requires-module.decorator';

/**
 * Workforce Management (HR) controller — employees, departments, positions,
 * shifts, attendance, timesheets, leave, holidays, payroll, payslips,
 * advances, loans, bank payments, performance reviews and reports.
 *
 * Every route is org-scoped by the tenancy extension and gated with `hr:*`
 * permissions (registered with the ModuleRegistry).
 */
@RequiresModule('hr')
@Controller('hr')
export class HrController {
  constructor(
    private readonly org: HrOrgService,
    private readonly attendance: HrAttendanceService,
    private readonly timesheets: HrTimesheetService,
    private readonly leave: HrLeaveService,
    private readonly payroll: HrPayrollService,
    private readonly reports: HrReportsService,
    private readonly access: HrAccessService,
    private readonly lifecycle: HrLifecycleService,
    private readonly self: HrSelfService,
    private readonly documents: HrDocumentsService,
    private readonly analytics: HrAnalyticsService,
  ) {}

  // ── Self-service ─────────────────────────────────────────────────────────
  //
  // No `hr:*` permission on any of these. Each one resolves the caller's own
  // employee record from the session, so the only record reachable is their own
  // (or, for /team, one of their own reports). Requiring `hr:read` here would
  // hand every cashier the whole staff directory just so they could see their
  // own payslip — strictly worse for confidentiality.
  //
  // Declared before the `employees/:id` routes so no static segment below can
  // ever be swallowed by a param route.

  @Get('me')
  me() {
    return this.self.me();
  }

  @Get('me/attendance')
  myAttendance(@Query() query: any) {
    return this.self.myAttendance(query);
  }

  @Post('me/clock')
  clockSelf(@Body() dto: any) {
    return this.self.clock(dto);
  }

  @Get('me/leave')
  myLeave(@Query() query: any) {
    return this.self.myLeave(query);
  }

  @Get('me/leave/balances')
  myLeaveBalances(@Query() query: any) {
    return this.self.myLeaveBalances(query);
  }

  @Post('me/leave')
  requestOwnLeave(@Body() dto: any) {
    return this.self.requestLeave(dto);
  }

  @Post('me/leave/:id/cancel')
  cancelOwnLeave(@Param('id') id: string) {
    return this.self.cancelMyLeave(id);
  }

  @Get('me/payslips')
  myPayslips(@Query() query: any) {
    return this.self.myPayslips(query);
  }

  @Get('me/trainings')
  myTrainings() {
    return this.self.myTrainings();
  }

  // ── Manager self-service ─────────────────────────────────────────────────

  @Get('team')
  team() {
    return this.self.team();
  }

  @Get('team/today')
  teamToday() {
    return this.self.teamToday();
  }

  @Get('team/leave')
  teamLeave(@Query() query: any) {
    return this.self.teamLeave(query);
  }

  @Post('team/leave/:id/approve')
  approveTeamLeave(@Param('id') id: string, @Body() dto: any) {
    return this.self.approveTeamLeave(id, dto);
  }

  @Post('team/leave/:id/reject')
  rejectTeamLeave(@Param('id') id: string, @Body() dto: any) {
    return this.self.rejectTeamLeave(id, dto);
  }

  // ── Dashboard / reports ──────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermissions('hr:read')
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('reports/workforce-sales')
  @RequirePermissions('hr:report')
  workforceSales(@Query() query: any) {
    return this.analytics.workforceSales(query);
  }

  @Get('reports/workforce-access')
  @RequirePermissions('hr:read')
  workforceAccess() {
    return this.analytics.workforceAccess();
  }

  @Get('reports/headcount-trend')
  @RequirePermissions('hr:report')
  headcountTrend(@Query('months') months?: string) {
    return this.reports.headcountTrend(months ? Number(months) : 6);
  }

  @Get('reports/payroll-register/:runId')
  @RequirePermissions('hr:report')
  payrollRegister(@Param('runId') runId: string) {
    return this.reports.payrollRegister(runId);
  }

  @Get('reports/attendance-register')
  @RequirePermissions('hr:report')
  attendanceRegister(@Query() query: any) {
    return this.reports.attendanceRegister(query);
  }

  @Get('reports/leave-overview')
  @RequirePermissions('hr:report')
  leaveOverview(@Query() query: any) {
    return this.reports.leaveOverview(query);
  }

  // ── Departments ──────────────────────────────────────────────────────────

  @Get('departments')
  @RequirePermissions('hr:read')
  listDepartments(@Query() query: any) {
    return this.org.listDepartments(query);
  }

  @Get('departments/:id')
  @RequirePermissions('hr:read')
  getDepartment(@Param('id') id: string) {
    return this.org.getDepartment(id);
  }

  @Post('departments')
  @RequirePermissions('hr:employee')
  createDepartment(@Body() dto: any) {
    return this.org.createDepartment(dto);
  }

  @Patch('departments/:id')
  @RequirePermissions('hr:employee')
  updateDepartment(@Param('id') id: string, @Body() dto: any) {
    return this.org.updateDepartment(id, dto);
  }

  @Delete('departments/:id')
  @RequirePermissions('hr:employee')
  deleteDepartment(@Param('id') id: string) {
    return this.org.deleteDepartment(id);
  }

  // ── Positions ────────────────────────────────────────────────────────────

  @Get('positions')
  @RequirePermissions('hr:read')
  listPositions(@Query() query: any) {
    return this.org.listPositions(query);
  }

  @Post('positions')
  @RequirePermissions('hr:employee')
  createPosition(@Body() dto: any) {
    return this.org.createPosition(dto);
  }

  @Patch('positions/:id')
  @RequirePermissions('hr:employee')
  updatePosition(@Param('id') id: string, @Body() dto: any) {
    return this.org.updatePosition(id, dto);
  }

  @Delete('positions/:id')
  @RequirePermissions('hr:employee')
  deletePosition(@Param('id') id: string) {
    return this.org.deletePosition(id);
  }

  // ── Employees ────────────────────────────────────────────────────────────

  @Get('employees')
  @RequirePermissions('hr:read')
  listEmployees(@Query() query: any) {
    return this.org.listEmployees(query);
  }

  @Get('employees/:id')
  @RequirePermissions('hr:read')
  getEmployee(@Param('id') id: string) {
    return this.org.getEmployee(id);
  }

  @Post('employees')
  @RequirePermissions('hr:employee')
  createEmployee(@Body() dto: any) {
    return this.org.createEmployee(dto);
  }

  @Patch('employees/:id')
  @RequirePermissions('hr:employee')
  updateEmployee(@Param('id') id: string, @Body() dto: any) {
    return this.org.updateEmployee(id, dto);
  }

  @Delete('employees/:id')
  @RequirePermissions('hr:employee')
  deleteEmployee(@Param('id') id: string) {
    return this.org.deleteEmployee(id);
  }

  // ── Identity spine: employee <-> user account ────────────────────────────
  //
  // Gated on `hr:access` rather than `hr:employee`: editing someone's phone
  // number and granting them a login are different powers. Reading the panel
  // is gated too — it exposes role grants and POS access.

  /** Accounts with no employee yet — the "Link employee" picker source. */
  @Get('access/linkable-users')
  @RequirePermissions('hr:access')
  linkableUsers(@Query() query: any) {
    return this.access.listLinkableUsers(query);
  }

  @Get('employees/:id/access')
  @RequirePermissions('hr:access')
  getAccess(@Param('id') id: string) {
    return this.access.getAccess(id);
  }

  @Post('employees/:id/link-user')
  @RequirePermissions('hr:access')
  linkUser(@Param('id') id: string, @Body() dto: LinkUserDto) {
    return this.access.linkUser(id, dto);
  }

  @Delete('employees/:id/link-user')
  @RequirePermissions('hr:access')
  unlinkUser(@Param('id') id: string) {
    return this.access.unlinkUser(id);
  }

  /** Create a login for an employee who has none, then link it. */
  @Post('employees/:id/provision-user')
  @RequirePermissions('hr:access', 'user:create')
  provisionUser(@Param('id') id: string, @Body() dto: ProvisionUserDto) {
    return this.access.provisionUser(id, dto);
  }

  /** Change roles / enabled state on the linked account. */
  @Patch('employees/:id/access')
  @RequirePermissions('hr:access', 'role:update')
  updateAccess(@Param('id') id: string, @Body() dto: UpdateAccessDto) {
    return this.access.updateAccess(id, dto);
  }

  /** Set or reset the linked account's POS PIN. Same power as the Staff screen's. */
  @Post('employees/:id/access/pin')
  @RequirePermissions('hr:access', 'user:update')
  setPin(@Param('id') id: string, @Body() dto: SetPinDto) {
    return this.access.setPin(id, dto.pin);
  }

  @Delete('employees/:id/access/pin')
  @RequirePermissions('hr:access', 'user:update')
  clearPin(@Param('id') id: string) {
    return this.access.clearPin(id);
  }

  // ── Employment lifecycle ─────────────────────────────────────────────────
  //
  // Gated on `hr:access` rather than `hr:employee`: correcting a phone number
  // and ending someone's employment are not the same power.

  @Post('employees/:id/terminate')
  @RequirePermissions('hr:access')
  terminate(@Param('id') id: string, @Body() dto: TerminateEmployeeDto) {
    return this.lifecycle.terminate(id, dto);
  }

  @Post('employees/:id/suspend')
  @RequirePermissions('hr:access')
  suspend(@Param('id') id: string, @Body() dto: SuspendEmployeeDto) {
    return this.lifecycle.suspend(id, dto);
  }

  @Post('employees/:id/reactivate')
  @RequirePermissions('hr:access')
  reactivate(@Param('id') id: string, @Body() dto: ReactivateEmployeeDto) {
    return this.lifecycle.reactivate(id, dto);
  }

  @Post('employees/:id/confirm')
  @RequirePermissions('hr:access')
  confirmEmployee(@Param('id') id: string, @Body() dto: ConfirmEmployeeDto) {
    return this.lifecycle.confirm(id, dto);
  }

  @Post('employees/:id/transfer')
  @RequirePermissions('hr:access')
  transfer(@Param('id') id: string, @Body() dto: TransferEmployeeDto) {
    return this.lifecycle.transfer(id, dto);
  }

  @Get('employees/:id/status-history')
  @RequirePermissions('hr:read')
  statusHistory(@Param('id') id: string) {
    return this.lifecycle.statusHistory(id);
  }

  @Get('employees/:id/transfers')
  @RequirePermissions('hr:read')
  transferHistory(@Param('id') id: string) {
    return this.lifecycle.transferHistory(id);
  }

  // ── POS x HR analytics (read-only) ───────────────────────────────────────

  @Get('employees/:id/pos-activity')
  @RequirePermissions('hr:report')
  posActivity(@Param('id') id: string, @Query() query: any) {
    return this.analytics.posActivity(id, query);
  }

  // ── Employee documents ───────────────────────────────────────────────────

  @Get('documents/expiring')
  @RequirePermissions('hr:document')
  expiringDocuments(@Query('days') days?: string) {
    return this.documents.expiring(days ? Number(days) : 60);
  }

  @Get('documents')
  @RequirePermissions('hr:document')
  listDocuments(@Query() query: any) {
    return this.documents.list(query);
  }

  @Post('documents')
  @RequirePermissions('hr:document')
  createDocument(@Body() dto: any) {
    return this.documents.create(dto);
  }

  @Patch('documents/:id')
  @RequirePermissions('hr:document')
  updateDocument(@Param('id') id: string, @Body() dto: any) {
    return this.documents.update(id, dto);
  }

  @Delete('documents/:id')
  @RequirePermissions('hr:document')
  deleteDocument(@Param('id') id: string) {
    return this.documents.remove(id);
  }

  // ── Training ─────────────────────────────────────────────────────────────

  @Get('training/programs')
  @RequirePermissions('hr:training')
  listPrograms(@Query() query: any) {
    return this.documents.listPrograms(query);
  }

  @Post('training/programs')
  @RequirePermissions('hr:training')
  createProgram(@Body() dto: any) {
    return this.documents.createProgram(dto);
  }

  @Patch('training/programs/:id')
  @RequirePermissions('hr:training')
  updateProgram(@Param('id') id: string, @Body() dto: any) {
    return this.documents.updateProgram(id, dto);
  }

  @Delete('training/programs/:id')
  @RequirePermissions('hr:training')
  deleteProgram(@Param('id') id: string) {
    return this.documents.removeProgram(id);
  }

  @Get('training/enrolments')
  @RequirePermissions('hr:training')
  listEnrolments(@Query() query: any) {
    return this.documents.listEnrolments(query);
  }

  @Post('training/enrolments')
  @RequirePermissions('hr:training')
  enrol(@Body() dto: any) {
    return this.documents.enrol(dto);
  }

  @Patch('training/enrolments/:id')
  @RequirePermissions('hr:training')
  updateEnrolment(@Param('id') id: string, @Body() dto: any) {
    return this.documents.updateEnrolment(id, dto);
  }

  @Delete('training/enrolments/:id')
  @RequirePermissions('hr:training')
  deleteEnrolment(@Param('id') id: string) {
    return this.documents.removeEnrolment(id);
  }

  // ── Shifts + assignments ─────────────────────────────────────────────────

  @Get('shifts')
  @RequirePermissions('hr:read')
  listShifts(@Query() query: any) {
    return this.org.listShifts(query);
  }

  @Post('shifts')
  @RequirePermissions('hr:shift')
  createShift(@Body() dto: any) {
    return this.org.createShift(dto);
  }

  @Patch('shifts/:id')
  @RequirePermissions('hr:shift')
  updateShift(@Param('id') id: string, @Body() dto: any) {
    return this.org.updateShift(id, dto);
  }

  @Delete('shifts/:id')
  @RequirePermissions('hr:shift')
  deleteShift(@Param('id') id: string) {
    return this.org.deleteShift(id);
  }

  @Get('assignments')
  @RequirePermissions('hr:read')
  listAssignments(@Query() query: any) {
    return this.org.listAssignments(query);
  }

  @Post('assignments')
  @RequirePermissions('hr:shift')
  assignShift(@Body() dto: any) {
    return this.org.assignShift(dto);
  }

  @Delete('assignments/:id')
  @RequirePermissions('hr:shift')
  revokeAssignment(@Param('id') id: string) {
    return this.org.revokeAssignment(id);
  }

  // ── Attendance ───────────────────────────────────────────────────────────

  @Post('attendance/clock')
  @RequirePermissions('hr:attendance')
  clock(@Body() dto: any) {
    return this.attendance.clock(dto);
  }

  @Post('attendance/manual')
  @RequirePermissions('hr:attendance')
  upsertManual(@Body() dto: any) {
    return this.attendance.upsertManual(dto);
  }

  @Get('attendance')
  @RequirePermissions('hr:attendance')
  listAttendance(@Query() query: any) {
    return this.attendance.listAttendance(query);
  }

  @Get('attendance/summary')
  @RequirePermissions('hr:attendance')
  attendanceSummary(@Query() query: any) {
    return this.attendance.summary(query);
  }

  @Get('attendance/:id')
  @RequirePermissions('hr:attendance')
  getAttendance(@Param('id') id: string) {
    return this.attendance.getAttendance(id);
  }

  @Get('attendance-logs')
  @RequirePermissions('hr:attendance')
  listLogs(@Query() query: any) {
    return this.attendance.listLogs(query);
  }

  // ── Timesheets ───────────────────────────────────────────────────────────

  @Get('timesheets')
  @RequirePermissions('hr:timesheet')
  listTimesheets(@Query() query: any) {
    return this.timesheets.list(query);
  }

  @Get('timesheets/:id')
  @RequirePermissions('hr:timesheet')
  getTimesheet(@Param('id') id: string) {
    return this.timesheets.get(id);
  }

  @Post('timesheets')
  @RequirePermissions('hr:timesheet')
  createTimesheet(@Body() dto: any) {
    return this.timesheets.create(dto);
  }

  @Patch('timesheets/:id')
  @RequirePermissions('hr:timesheet')
  updateTimesheet(@Param('id') id: string, @Body() dto: any) {
    return this.timesheets.update(id, dto);
  }

  @Post('timesheets/:id/submit')
  @RequirePermissions('hr:timesheet')
  submitTimesheet(@Param('id') id: string) {
    return this.timesheets.submit(id);
  }

  @Post('timesheets/:id/approve')
  @RequirePermissions('hr:timesheet')
  approveTimesheet(@Param('id') id: string) {
    return this.timesheets.approve(id);
  }

  @Post('timesheets/:id/reject')
  @RequirePermissions('hr:timesheet')
  rejectTimesheet(@Param('id') id: string, @Body() dto: any) {
    return this.timesheets.reject(id, dto);
  }

  @Delete('timesheets/:id')
  @RequirePermissions('hr:timesheet')
  deleteTimesheet(@Param('id') id: string) {
    return this.timesheets.delete(id);
  }

  @Post('timesheets/:id/entries')
  @RequirePermissions('hr:timesheet')
  addEntry(@Param('id') id: string, @Body() dto: any) {
    return this.timesheets.addEntry(id, dto);
  }

  @Patch('timesheets/entries/:entryId')
  @RequirePermissions('hr:timesheet')
  updateEntry(@Param('entryId') entryId: string, @Body() dto: any) {
    return this.timesheets.updateEntry(entryId, dto);
  }

  @Delete('timesheets/entries/:entryId')
  @RequirePermissions('hr:timesheet')
  deleteEntry(@Param('entryId') entryId: string) {
    return this.timesheets.deleteEntry(entryId);
  }

  // ── Leave ────────────────────────────────────────────────────────────────

  @Get('leave/types')
  @RequirePermissions('hr:leave')
  listLeaveTypes(@Query() query: any) {
    return this.leave.listTypes(query);
  }

  @Post('leave/types')
  @RequirePermissions('hr:leave')
  createLeaveType(@Body() dto: any) {
    return this.leave.createType(dto);
  }

  @Patch('leave/types/:id')
  @RequirePermissions('hr:leave')
  updateLeaveType(@Param('id') id: string, @Body() dto: any) {
    return this.leave.updateType(id, dto);
  }

  @Delete('leave/types/:id')
  @RequirePermissions('hr:leave')
  deleteLeaveType(@Param('id') id: string) {
    return this.leave.deleteType(id);
  }

  @Get('leave/balances')
  @RequirePermissions('hr:leave')
  listLeaveBalances(@Query() query: any) {
    return this.leave.listBalances(query);
  }

  @Post('leave/balances/adjust')
  @RequirePermissions('hr:leave')
  adjustBalance(@Body() dto: any) {
    return this.leave.adjustBalance(dto);
  }

  @Get('leave/requests')
  @RequirePermissions('hr:leave')
  listLeaveRequests(@Query() query: any) {
    return this.leave.listRequests(query);
  }

  @Post('leave/requests')
  @RequirePermissions('hr:leave')
  createLeaveRequest(@Body() dto: any) {
    return this.leave.createRequest(dto);
  }

  @Post('leave/requests/:id/approve')
  @RequirePermissions('hr:leave')
  approveLeaveRequest(@Param('id') id: string, @Body() dto: any) {
    return this.leave.approveRequest(id, dto);
  }

  @Post('leave/requests/:id/reject')
  @RequirePermissions('hr:leave')
  rejectLeaveRequest(@Param('id') id: string, @Body() dto: any) {
    return this.leave.rejectRequest(id, dto);
  }

  @Post('leave/requests/:id/cancel')
  @RequirePermissions('hr:leave')
  cancelLeaveRequest(@Param('id') id: string) {
    return this.leave.cancelRequest(id);
  }

  @Get('holidays')
  @RequirePermissions('hr:holiday')
  listHolidays(@Query() query: any) {
    return this.leave.listHolidays(query);
  }

  @Post('holidays')
  @RequirePermissions('hr:holiday')
  createHoliday(@Body() dto: any) {
    return this.leave.createHoliday(dto);
  }

  @Patch('holidays/:id')
  @RequirePermissions('hr:holiday')
  updateHoliday(@Param('id') id: string, @Body() dto: any) {
    return this.leave.updateHoliday(id, dto);
  }

  @Delete('holidays/:id')
  @RequirePermissions('hr:holiday')
  deleteHoliday(@Param('id') id: string) {
    return this.leave.deleteHoliday(id);
  }

  // ── Payroll components + tax tables ──────────────────────────────────────

  @Get('payroll/components')
  @RequirePermissions('hr:payroll')
  listComponents(@Query() query: any) {
    return this.payroll.listComponents(query);
  }

  @Post('payroll/components')
  @RequirePermissions('hr:payroll')
  createComponent(@Body() dto: any) {
    return this.payroll.createComponent(dto);
  }

  @Patch('payroll/components/:id')
  @RequirePermissions('hr:payroll')
  updateComponent(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.updateComponent(id, dto);
  }

  @Delete('payroll/components/:id')
  @RequirePermissions('hr:payroll')
  deleteComponent(@Param('id') id: string) {
    return this.payroll.deleteComponent(id);
  }

  @Get('payroll/tax-tables')
  @RequirePermissions('hr:tax_table')
  listTaxTables(@Query() query: any) {
    return this.payroll.listTaxTables(query);
  }

  @Post('payroll/tax-tables')
  @RequirePermissions('hr:tax_table')
  createTaxTable(@Body() dto: any) {
    return this.payroll.createTaxTable(dto);
  }

  @Patch('payroll/tax-tables/:id')
  @RequirePermissions('hr:tax_table')
  updateTaxTable(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.updateTaxTable(id, dto);
  }

  @Delete('payroll/tax-tables/:id')
  @RequirePermissions('hr:tax_table')
  deleteTaxTable(@Param('id') id: string) {
    return this.payroll.deleteTaxTable(id);
  }

  // ── Payroll periods + runs ───────────────────────────────────────────────

  @Get('payroll/periods')
  @RequirePermissions('hr:payroll')
  listPeriods(@Query() query: any) {
    return this.payroll.listPeriods(query);
  }

  @Post('payroll/periods')
  @RequirePermissions('hr:payroll')
  createPeriod(@Body() dto: any) {
    return this.payroll.createPeriod(dto);
  }

  @Patch('payroll/periods/:id')
  @RequirePermissions('hr:payroll')
  updatePeriod(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.updatePeriod(id, dto);
  }

  @Get('payroll/runs')
  @RequirePermissions('hr:payroll')
  listRuns(@Query() query: any) {
    return this.payroll.listRuns(query);
  }

  @Get('payroll/runs/:id')
  @RequirePermissions('hr:payroll')
  getRun(@Param('id') id: string) {
    return this.payroll.getRun(id);
  }

  @Post('payroll/runs')
  @RequirePermissions('hr:payroll')
  createRun(@Body() dto: any) {
    return this.payroll.createRun(dto);
  }

  @Post('payroll/runs/:id/calculate')
  @RequirePermissions('hr:payroll')
  calculateRun(@Param('id') id: string) {
    return this.payroll.calculateRun(id);
  }

  @Post('payroll/runs/:id/approve')
  @RequirePermissions('hr:payroll')
  approveRun(@Param('id') id: string) {
    return this.payroll.approveRun(id);
  }

  @Post('payroll/runs/:id/reverse')
  @RequirePermissions('hr:payroll')
  reverseRun(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.reverseRun(id, dto);
  }

  @Delete('payroll/runs/:id')
  @RequirePermissions('hr:payroll')
  deleteRun(@Param('id') id: string) {
    return this.payroll.deleteRun(id);
  }

  // ── Payslips ─────────────────────────────────────────────────────────────

  @Get('payslips')
  @RequirePermissions('hr:payslip')
  listPayslips(@Query() query: any) {
    return this.payroll.listPayslips(query);
  }

  @Get('payslips/:id')
  @RequirePermissions('hr:payslip')
  getPayslip(@Param('id') id: string) {
    return this.payroll.getPayslip(id);
  }

  @Post('payslips/:id/paid')
  @RequirePermissions('hr:payslip')
  markPayslipPaid(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.markPaid(id, dto);
  }

  // ── Bank payments ────────────────────────────────────────────────────────

  @Get('bank-payments')
  @RequirePermissions('hr:payroll')
  listBankPayments(@Query() query: any) {
    return this.payroll.listBankPayments(query);
  }

  @Post('bank-payments/generate')
  @RequirePermissions('hr:payroll')
  generateBankPayment(@Body() dto: any) {
    return this.payroll.generateBankPayment(dto);
  }

  @Patch('bank-payments/:id/status')
  @RequirePermissions('hr:payroll')
  updateBankPaymentStatus(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.updateBankPaymentStatus(id, dto);
  }

  // ── Advances + loans ─────────────────────────────────────────────────────

  @Get('advances')
  @RequirePermissions('hr:advance')
  listAdvances(@Query() query: any) {
    return this.payroll.listAdvances(query);
  }

  @Post('advances')
  @RequirePermissions('hr:advance')
  createAdvance(@Body() dto: any) {
    return this.payroll.createAdvance(dto);
  }

  @Post('advances/:id/approve')
  @RequirePermissions('hr:advance')
  approveAdvance(@Param('id') id: string) {
    return this.payroll.approveAdvance(id);
  }

  @Post('advances/:id/paid')
  @RequirePermissions('hr:advance')
  markAdvancePaid(@Param('id') id: string) {
    return this.payroll.markAdvancePaid(id);
  }

  @Post('advances/:id/reject')
  @RequirePermissions('hr:advance')
  rejectAdvance(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.rejectAdvance(id, dto);
  }

  @Get('loans')
  @RequirePermissions('hr:loan')
  listLoans(@Query() query: any) {
    return this.payroll.listLoans(query);
  }

  @Post('loans')
  @RequirePermissions('hr:loan')
  createLoan(@Body() dto: any) {
    return this.payroll.createLoan(dto);
  }

  @Patch('loans/:id')
  @RequirePermissions('hr:loan')
  updateLoan(@Param('id') id: string, @Body() dto: any) {
    return this.payroll.updateLoan(id, dto);
  }

  @Delete('loans/:id')
  @RequirePermissions('hr:loan')
  deleteLoan(@Param('id') id: string) {
    return this.payroll.deleteLoan(id);
  }

  // ── Performance reviews ──────────────────────────────────────────────────

  @Get('reviews')
  @RequirePermissions('hr:performance')
  listReviews(@Query() query: any) {
    return this.reports.listReviews(query);
  }

  @Post('reviews')
  @RequirePermissions('hr:performance')
  createReview(@Body() dto: any) {
    return this.reports.createReview(dto);
  }

  @Patch('reviews/:id')
  @RequirePermissions('hr:performance')
  updateReview(@Param('id') id: string, @Body() dto: any) {
    return this.reports.updateReview(id, dto);
  }

  @Delete('reviews/:id')
  @RequirePermissions('hr:performance')
  deleteReview(@Param('id') id: string) {
    return this.reports.deleteReview(id);
  }
}
