import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

interface E2EStackState {
  api_base_url: string
  web_origin: string
  admin_username: string
  admin_password: string
  doctor_b_username: string
  doctor_b_password: string
  doctor_b_case_id: string
  failed_job_id: string
  flair_nifti_path: string
  t1ce_nifti_path: string
  worker_mode: string
}

interface ParsedNiftiMask {
  sizeofHdr: number
  dim: [number, number, number, number]
  datatype: number
  bitpix: number
  voxOffset: number
  srowXNonZero: boolean
  voxelCount: number
  foregroundVoxels: number
  uniqueLabels: number[]
}

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url))
const FE_ROOT = resolve(CURRENT_DIR, '..')
const STACK_STATE_PATH = resolve(FE_ROOT, 'test-results/e2e-stack-state.json')

function readStackState(): E2EStackState {
  const raw = readFileSync(STACK_STATE_PATH, 'utf8')
  return JSON.parse(raw) as E2EStackState
}

function parseAndValidateNiftiMask(niiBytes: Uint8Array): ParsedNiftiMask {
  if (niiBytes.byteLength < 352) {
    throw new Error(`NIfTI buffer quá ngắn (${niiBytes.byteLength} bytes)`)
  }
  const view = new DataView(niiBytes.buffer, niiBytes.byteOffset, niiBytes.byteLength)
  const sizeofHdr = view.getInt32(0, true)
  const dim: [number, number, number, number] = [
    view.getInt16(40, true),
    view.getInt16(42, true),
    view.getInt16(44, true),
    view.getInt16(46, true),
  ]
  const datatype = view.getInt16(70, true)
  const bitpix = view.getInt16(72, true)
  const voxOffset = Math.trunc(view.getFloat32(108, true))
  const srowX = [
    view.getFloat32(280, true),
    view.getFloat32(284, true),
    view.getFloat32(288, true),
    view.getFloat32(292, true),
  ]
  const srowXNonZero = srowX[0] !== 0 || srowX[1] !== 0 || srowX[2] !== 0
  const expectedVoxels = dim[1] * dim[2] * dim[3]
  const voxelEnd = voxOffset + expectedVoxels
  if (voxelEnd > niiBytes.byteLength) {
    throw new Error(
      `Dữ liệu voxel NIfTI không đủ kích thước (cần ${voxelEnd}, nhận ${niiBytes.byteLength})`,
    )
  }
  const voxelData = niiBytes.subarray(voxOffset, voxelEnd)
  const seen = new Set<number>()
  let foregroundVoxels = 0
  for (let i = 0; i < voxelData.length; i += 1) {
    const val = voxelData[i]!
    seen.add(val)
    if (val !== 0) {
      foregroundVoxels += 1
    }
  }
  return {
    sizeofHdr,
    dim,
    datatype,
    bitpix,
    voxOffset,
    srowXNonZero,
    voxelCount: voxelData.length,
    foregroundVoxels,
    uniqueLabels: Array.from(seen).sort((a, b) => a - b),
  }
}

async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login')
  const usernameInput = page.locator('#login-username')
  await expect(usernameInput).toBeVisible()
  await usernameInput.fill(username)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflowPx = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflowPx).toBeLessThanOrEqual(0)
}

async function assertNoPatientPiiVisible(
  page: Page,
  forbiddenTokens: string[],
): Promise<void> {
  const bodyText = await page.locator('body').innerText()
  for (const token of forbiddenTokens) {
    expect(bodyText).not.toContain(token)
  }
}

test.describe.serial('P7 Full-Stack Acceptance E2E', () => {
  let stackState: E2EStackState

  const doctorAUsername = 'bs.p7.alpha'
  const doctorADisplayName = 'BS. Kiem Thu P7'
  const doctorAInitialTempPassword = 'P7TempPass!2026'
  const doctorANewPassword = 'P7DoctorPass!2026'

  const patientCode = 'BN-P7-001'
  const patientFullName = 'Benh Nhan Kiem Thu P7'
  const caseClinicalNote = 'Ca P7 E2E ghi chu lam sang'

  let doctorAPatientId = ''
  let doctorACaseId = ''

  test.beforeAll(() => {
    stackState = readStackState()
  })

  test('1. Full Doctor & Admin E2E Lifecycle + Axial Edit + Undo/Redo + Save + Reload + NIfTI Export Verification', async ({
    page,
  }) => {
    // 1. Admin creates Doctor A with temporary password
    await loginAs(page, stackState.admin_username, stackState.admin_password)
    await expect(page).toHaveURL(/\/admin$/)

    await page.getByRole('link', { name: 'Tài khoản bác sĩ', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/users$/)

    await page.getByRole('button', { name: 'Tạo tài khoản bác sĩ', exact: true }).click()
    const createDoctorDialog = page.getByRole('dialog')
    await expect(createDoctorDialog).toBeVisible()
    await createDoctorDialog.locator('#create-doctor-username').fill(doctorAUsername)
    await createDoctorDialog.locator('#create-doctor-display-name').fill(doctorADisplayName)
    await createDoctorDialog
      .locator('#create-doctor-temp-password')
      .fill(doctorAInitialTempPassword)
    await createDoctorDialog
      .getByRole('button', { name: 'Tạo tài khoản', exact: true })
      .click()

    const tempPasswordBanner = page.locator('[data-testid="one-time-temp-password"]')
    await expect(tempPasswordBanner).toBeVisible()
    const issuedTempPassword = (await tempPasswordBanner.innerText()).trim()
    expect(issuedTempPassword.length).toBeGreaterThanOrEqual(12)

    await page
      .getByRole('button', { name: 'Đã ghi nhận, đóng hộp thoại', exact: true })
      .click()
    await expect(tempPasswordBanner).toBeHidden()
    await expect(page.locator('tr', { hasText: doctorAUsername })).toBeVisible()

    await logout(page)

    // 2. Doctor A logs in with temporary password -> forced password change -> re-login
    await loginAs(page, doctorAUsername, issuedTempPassword)
    await expect(page).toHaveURL(/\/change-password$/)
    await expect(page.getByText('Yêu cầu đổi mật khẩu tạm', { exact: true }).first()).toBeVisible()

    await page.locator('#cp-current').fill(issuedTempPassword)
    await page.locator('#cp-new').fill(doctorANewPassword)
    await page.locator('#cp-confirm').fill(doctorANewPassword)
    await page.getByRole('button', { name: 'Lưu mật khẩu mới', exact: true }).click()

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText('Đổi mật khẩu thành công', { exact: true })).toBeVisible()

    await page.locator('#login-username').fill(doctorAUsername)
    await page.locator('#login-password').fill(doctorANewPassword)
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
    await expect(page).toHaveURL(/\/doctor$/)

    // 3. Doctor A creates patient & case
    await page.getByRole('link', { name: 'Bệnh nhân', exact: true }).click()
    await expect(page).toHaveURL(/\/doctor\/patients$/)

    await page.getByRole('button', { name: 'Thêm bệnh nhân', exact: true }).click()
    const createPatientDialog = page.getByRole('dialog')
    await expect(createPatientDialog).toBeVisible()
    await createPatientDialog.locator('#patient-code-input').fill(patientCode)
    await createPatientDialog.locator('#patient-fullname-input').fill(patientFullName)
    await createPatientDialog.locator('#patient-birthyear-input').fill('1978')
    await createPatientDialog.locator('#patient-sex-select').selectOption('male')
    await createPatientDialog.getByRole('button', { name: 'Tạo hồ sơ', exact: true }).click()
    await expect(createPatientDialog).toBeHidden()

    const patientRow = page.locator('tr', { hasText: patientCode })
    await expect(patientRow).toBeVisible()
    await patientRow.getByRole('link', { name: /Xem hồ sơ/ }).first().click()
    await expect(page).toHaveURL(/\/doctor\/patients\/[^/]+$/)
    doctorAPatientId = new URL(page.url()).pathname.split('/').pop() ?? ''
    expect(doctorAPatientId).not.toBe('')

    await page.getByRole('button', { name: 'Tạo ca chụp mới', exact: true }).click()
    const createCaseDialog = page.getByRole('dialog')
    await expect(createCaseDialog).toBeVisible()
    await createCaseDialog.locator('#case-notes-input').fill(caseClinicalNote)
    await createCaseDialog.getByRole('button', { name: 'Tạo ca chụp', exact: true }).click()

    await expect(page).toHaveURL(/\/doctor\/cases\/[^/]+$/)
    doctorACaseId = new URL(page.url()).pathname.split('/').pop() ?? ''
    expect(doctorACaseId).not.toBe('')

    // 4. Upload FLAIR + T1CE and run deterministic AI segmentation
    await page
      .locator('[data-testid="volume-slot-flair"] input[type="file"]')
      .setInputFiles(stackState.flair_nifti_path)
    await expect(
      page.locator('[data-testid="volume-slot-flair"]').getByText('Hợp lệ', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })

    await page
      .locator('[data-testid="volume-slot-t1ce"] input[type="file"]')
      .setInputFiles(stackState.t1ce_nifti_path)
    await expect(
      page.locator('[data-testid="volume-slot-t1ce"]').getByText('Hợp lệ', { exact: true }),
    ).toBeVisible({ timeout: 30_000 })

    const runAiButton = page.getByRole('button', { name: 'Chạy phân đoạn AI', exact: true })
    await expect(runAiButton).toBeEnabled()
    await runAiButton.click()

    const queueConfirmDialog = page.getByRole('alertdialog')
    await expect(queueConfirmDialog).toBeVisible()
    await queueConfirmDialog.getByRole('button', { name: 'Gửi vào hàng đợi', exact: true }).click()

    const viewResultLink = page.getByRole('link', { name: 'Xem kết quả AI' }).first()
    await expect(page.getByText('Hoàn tất', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(viewResultLink).toBeVisible({ timeout: 30_000 })
    await viewResultLink.click()
    await expect(page).toHaveURL(/\/doctor\/cases\/[^/]+\/viewer/)

    // 5. Viewer: slice 78, brush stroke on axial canvas, Undo/Redo, Save v2, clean reload, NIfTI export
    const viewerWorkspace = page.locator(
      '[data-testid="mri-viewer-workspace"][data-volume-status="ready"]',
    )
    await expect(viewerWorkspace).toBeVisible({ timeout: 30_000 })

    const sliceInput = page.locator('#viewer-slice-input')
    await sliceInput.fill('78')
    await sliceInput.press('Enter')
    await expect(page.getByText(/Lát 78\s*\/\s*155/).first()).toBeVisible()

    await page.getByRole('button', { name: 'Tô mask', exact: true }).click()

    const axialCanvas = page.locator('[data-testid="pane-axial-editable"] canvas')
    await expect(axialCanvas).toBeVisible()
    const canvasBox = await axialCanvas.boundingBox()
    if (!canvasBox) {
      throw new Error('Không lấy được kích thước canvas axial')
    }

    const centerX = canvasBox.x + canvasBox.width * 0.5
    const centerY = canvasBox.y + canvasBox.height * 0.5
    await page.mouse.move(centerX, centerY)
    await page.mouse.down()
    await page.mouse.move(centerX - 35, centerY - 35, { steps: 6 })
    await page.mouse.up()

    const undoButton = page.getByRole('button', { name: 'Hoàn tác', exact: true })
    const redoButton = page.getByRole('button', { name: 'Làm lại', exact: true })
    await expect(undoButton).toBeEnabled()
    await undoButton.click()
    await expect(redoButton).toBeEnabled()
    await redoButton.click()

    const saveButton = page.getByRole('button', { name: 'Lưu phiên bản', exact: true })
    await expect(saveButton).toBeEnabled()
    await saveButton.click()

    const saveModal = page.getByRole('dialog')
    await expect(saveModal).toBeVisible()
    await saveModal.locator('#mask-save-note-input').fill('P7 axial manual edit v2')
    await saveModal.getByRole('button', { name: 'Xác nhận lưu phiên bản', exact: true }).click()
    await expect(saveModal).toBeHidden()

    const versionSelect = page.getByRole('combobox', { name: 'Chọn phiên bản mask' })
    await expect(versionSelect.locator('option:checked')).toContainText(/v2\s*·\s*Thủ công/)
    await expect(saveButton).toBeDisabled()
    await expect(viewerWorkspace).toBeVisible({ timeout: 30_000 })

    // Navigate without ?version=<v1_id> so reload exercises default active latest version (v2)
    await page.goto(`/doctor/cases/${doctorACaseId}/viewer`)
    await expect(viewerWorkspace).toBeVisible({ timeout: 30_000 })
    await page.reload()
    await expect(viewerWorkspace).toBeVisible({ timeout: 30_000 })
    await expect(versionSelect.locator('option:checked')).toContainText(/v2\s*·\s*Thủ công/)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Xuất (.nii.gz)', exact: true }).click(),
    ])
    const suggestedFilename = download.suggestedFilename()
    expect(suggestedFilename).toMatch(/^mask-case-.*-v2\.nii\.gz$/)
    expect(suggestedFilename.toLowerCase()).not.toContain('benh')
    expect(suggestedFilename.toLowerCase()).not.toContain('bn-p7')

    const downloadPath = await download.path()
    if (!downloadPath) {
      throw new Error('Playwright không trả về tệp NIfTI tải xuống')
    }
    const niftiBytes = gunzipSync(readFileSync(downloadPath))
    const parsedMask = parseAndValidateNiftiMask(niftiBytes)
    expect(parsedMask.sizeofHdr).toBe(348)
    expect(parsedMask.dim).toEqual([3, 240, 240, 155])
    expect(parsedMask.datatype).toBe(2)
    expect(parsedMask.bitpix).toBe(8)
    expect(parsedMask.voxOffset).toBeGreaterThanOrEqual(348)
    expect(parsedMask.srowXNonZero).toBe(true)
    expect(parsedMask.voxelCount).toBe(240 * 240 * 155)
    expect(parsedMask.foregroundVoxels).toBeGreaterThan(260)
    expect(
      parsedMask.uniqueLabels.every(
        (label) => label === 0 || label === 1 || label === 2 || label === 4,
      ),
    ).toBe(true)
    expect(parsedMask.uniqueLabels).toEqual(expect.arrayContaining([0, 1, 2, 4]))
  })

  test('2. QA-ACL-01, QA-ACL-02, QA-AUTH-05 — Negative Ownership, Role Isolation & Zero PII', async ({
    page,
  }) => {
    expect(doctorAPatientId).not.toBe('')
    expect(doctorACaseId).not.toBe('')

    const piiTokens = [patientFullName, patientCode, caseClinicalNote]

    // Doctor B cannot open Doctor A's patient, case, or viewer
    await loginAs(page, stackState.doctor_b_username, stackState.doctor_b_password)
    await expect(page).toHaveURL(/\/doctor$/)

    await page.goto(`/doctor/patients/${doctorAPatientId}`)
    await expect(page.getByText('Không thể truy cập hồ sơ bệnh nhân', { exact: true }).first()).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)

    await page.goto(`/doctor/cases/${doctorACaseId}`)
    await expect(page.getByText('Không thể truy cập ca chụp', { exact: true }).first()).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)

    await page.goto(`/doctor/cases/${doctorACaseId}/viewer`)
    await expect(page.getByText('Không thể mở Viewer cho ca chụp này', { exact: true }).first()).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)

    await logout(page)

    // Admin sees zero patient PII across all admin routes and gets 403 on clinical routes
    await loginAs(page, stackState.admin_username, stackState.admin_password)
    await expect(page).toHaveURL(/\/admin$/)
    await assertNoPatientPiiVisible(page, piiTokens)

    await page.goto('/admin/jobs')
    await expect(page.locator('#admin-job-search')).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)

    await page.goto('/admin/audit-events')
    await expect(
      page.getByRole('heading', { name: /Nhật ký sự kiện quản trị/i }),
    ).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)

    await page.goto(`/doctor/cases/${doctorACaseId}`)
    await expect(page).toHaveURL(/\/403$/)
    await expect(page.getByText('Mã lỗi 403', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Không có quyền truy cập', { exact: true }).first()).toBeVisible()
    await assertNoPatientPiiVisible(page, piiTokens)
  })

  test('3. P6 Admin Job Retry + QA-AUTH-04 Live Session Revocation When Admin Locks Doctor A', async ({
    browser,
  }) => {
    expect(doctorAPatientId).not.toBe('')

    const doctorContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })

    try {
      const doctorPage = await doctorContext.newPage()
      const adminPage = await adminContext.newPage()

      // Doctor A signs in and views patients table
      await loginAs(doctorPage, doctorAUsername, doctorANewPassword)
      await expect(doctorPage).toHaveURL(/\/doctor$/)
      await doctorPage.getByRole('link', { name: 'Bệnh nhân', exact: true }).click()
      await expect(doctorPage).toHaveURL(/\/doctor\/patients$/)
      const doctorAPatientRow = doctorPage.locator('tr', { hasText: patientCode })
      await expect(doctorAPatientRow).toBeVisible()

      // Admin retries seeded failed job first
      await loginAs(adminPage, stackState.admin_username, stackState.admin_password)
      await expect(adminPage).toHaveURL(/\/admin$/)
      await adminPage.getByRole('link', { name: 'Quản lý tác vụ AI', exact: true }).click()
      await expect(adminPage).toHaveURL(/\/admin\/jobs$/)

      await adminPage.locator('#admin-job-state').selectOption('failed')
      await adminPage.locator('#admin-job-search').fill(stackState.failed_job_id)

      const failedJobRow = adminPage.locator('tr', {
        hasText: stackState.failed_job_id,
      })
      await expect(failedJobRow).toBeVisible()
      await failedJobRow.getByRole('button', { name: 'Gửi lại', exact: true }).click()

      const retryConfirmDialog = adminPage.getByRole('alertdialog')
      await expect(retryConfirmDialog).toBeVisible()
      await retryConfirmDialog.getByRole('button', { name: 'Tạo job mới', exact: true }).click()

      // Retry success opens the detail modal for the newly created job
      const jobDetailDialog = adminPage.getByRole('dialog')
      await expect(jobDetailDialog).toBeVisible()
      const retriedJobIdLocator = jobDetailDialog.locator('dd').first()
      await expect(retriedJobIdLocator).toBeVisible()
      const retriedJobId = (await retriedJobIdLocator.innerText()).trim()
      expect(retriedJobId).not.toBe('')
      expect(retriedJobId).not.toBe(stackState.failed_job_id)

      await jobDetailDialog.getByRole('button', { name: 'Đóng hộp thoại', exact: true }).click()
      await expect(jobDetailDialog).toBeHidden()

      await adminPage.locator('#admin-job-state').selectOption('all')
      await adminPage.locator('#admin-job-search').fill(retriedJobId)
      await expect(
        adminPage.locator('tbody tr', { hasText: retriedJobId }).getByText('Hoàn tất', { exact: true }),
      ).toBeVisible({ timeout: 30_000 })

      // Admin locks Doctor A while Doctor A still has an active session in doctorContext
      await adminPage.getByRole('link', { name: 'Tài khoản bác sĩ', exact: true }).click()
      await expect(adminPage).toHaveURL(/\/admin\/users$/)
      const doctorARowInAdmin = adminPage.locator('tr', { hasText: doctorAUsername })
      await expect(doctorARowInAdmin).toBeVisible()
      await doctorARowInAdmin.getByRole('button', { name: 'Khóa', exact: true }).click()

      const lockConfirmDialog = adminPage.getByRole('alertdialog')
      await expect(lockConfirmDialog).toBeVisible()
      await lockConfirmDialog.getByRole('button', { name: 'Khóa tài khoản', exact: true }).click()
      await expect(doctorARowInAdmin.getByText('Đã khóa', { exact: true })).toBeVisible()

      // Doctor A attempts clinical action without logging out -> immediate 401 session revocation
      await doctorAPatientRow.getByRole('link', { name: /Xem hồ sơ/ }).first().click()
      await expect(doctorPage).toHaveURL(/\/login$/)
      await expect(
        doctorPage.getByText('Tài khoản đã bị khóa', { exact: true }).first(),
      ).toBeVisible()
      await assertNoPatientPiiVisible(doctorPage, [patientFullName, patientCode])

      // Verify locked Doctor A cannot log back in
      await doctorPage.locator('#login-username').fill(doctorAUsername)
      await doctorPage.locator('#login-password').fill(doctorANewPassword)
      await doctorPage.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
      await expect(doctorPage).toHaveURL(/\/login$/)
      await expect(
        doctorPage.getByRole('alert').filter({ hasText: /bị khóa/i }).first(),
      ).toBeVisible()
    } finally {
      await doctorContext.close()
      await adminContext.close()
    }
  })

  test('4. Responsive Desktop 1920/1440/1024 vs Narrow Read-Only 768/375 & Keyboard Escape', async ({
    page,
  }) => {
    await loginAs(page, stackState.doctor_b_username, stackState.doctor_b_password)
    await expect(page).toHaveURL(/\/doctor$/)

    await page.goto(`/doctor/cases/${stackState.doctor_b_case_id}/viewer`)
    const viewerWorkspace = page.locator(
      '[data-testid="mri-viewer-workspace"][data-volume-status="ready"]',
    )
    await expect(viewerWorkspace).toBeVisible({ timeout: 30_000 })

    const desktopViewports = [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
    ]
    for (const vp of desktopViewports) {
      await page.setViewportSize(vp)
      await expect(page.getByRole('button', { name: 'Tô mask', exact: true })).toBeEnabled()
      await assertNoHorizontalOverflow(page)
    }

    const narrowViewports = [
      { width: 768, height: 1024 },
      { width: 375, height: 812 },
    ]
    for (const vp of narrowViewports) {
      await page.setViewportSize(vp)
      await expect(page.getByRole('button', { name: 'Tô mask', exact: true })).toBeDisabled()
      await expect(page.getByText('Chỉnh sửa mask đang tạm khóa', { exact: true })).toBeVisible()
      await expect(page.locator('#viewer-slice-input')).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Lát kế tiếp', exact: true })).toBeEnabled()
      await assertNoHorizontalOverflow(page)
    }

    // Modal Escape key hygiene at 1280x800
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/doctor/patients')
    await page.getByRole('button', { name: 'Thêm bệnh nhân', exact: true }).click()
    const patientModal = page.getByRole('dialog')
    await expect(patientModal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(patientModal).toBeHidden()
  })
})
