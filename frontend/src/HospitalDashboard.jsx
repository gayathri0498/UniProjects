// frontend/src/HospitalDashboard.jsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  AppShell,
  AppShellHeader,
  AppShellMain,
  Container,
  Title,
  Text,
  Button,
  Card,
  TextInput,
  NumberInput,
  Select,
  MultiSelect,
  Grid,
  Group,
  Divider,
  Notification,
  Loader,
  Alert,
  Badge,
  Tabs,
  Table,
  Pagination,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconCheck,
  IconX,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import useMetadata from './hooks/useMetadata';
import { fetchForecast } from './api';
import ForecastChart from './components/ForecastChart';
import MapChoropleth from './components/MapChoropleth';

// Base URLs (override via .env)
//   REACT_APP_NODE_API_URL   -> Node server (patients/users)
//   REACT_APP_API_URL        -> FastAPI (alerts/forecasts)
const NODE_API = (process.env.REACT_APP_NODE_API_URL || 'http://127.0.0.1:5000').trim();
const FASTAPI  = (process.env.REACT_APP_API_URL      || 'http://127.0.0.1:8000').trim();

const nodeClient = axios.create({
  baseURL: NODE_API,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

const fastClient = axios.create({
  baseURL: FASTAPI,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Latency instrumentation toggle
const DEBUG_LATENCY = (process.env.REACT_APP_DEBUG_LATENCY ?? '1') !== '0';

// Helper: event-id generator (works in modern browsers; safe fallback)
const newEventId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Small helper: pick the “best” ID key for this hospital user
const hospitalKey = (u) => (u?.hospitalId || u?.username || u?.name || u?._id || '').toString();

// Compute local stats from patient rows
function computeStatsFromPatients(rows) {
  const diseases = {};
  const districts = new Set();
  let latest = null;

  for (const p of rows || []) {
    const d = String(p.disease || '').trim();
    const dist = String(p.district || '').trim();
    if (d) diseases[d] = (diseases[d] || 0) + 1;
    if (dist) districts.add(dist);

    const t = p.diagnosisDate ? new Date(p.diagnosisDate) : null;
    if (t && (!latest || t > latest)) latest = t;
  }

  const diseaseList = Object.entries(diseases)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, total }));

  return {
    diseaseList,
    districts: Array.from(districts).sort(),
    totalPatients: rows?.length || 0,
    lastReportAt: latest ? latest.toISOString() : null,
  };
}

export default function HospitalDashboard() {
  const navigate = useNavigate();
  let user = null;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch {}
  const myHospitalId = hospitalKey(user);

  const {
    metadata: { diseases, districts },
    loading: metaLoading,
  } = useMetadata();

  // Patient form
  const [form, setForm] = useState({
    _id: null,
    doctorname: '',
    disease: '',
    district: '',
    age: '',
    gender: '',
    symptoms: [],
    temperature: '',
    pulse: '',
    diagnosisDate: null,
  });

  // lists / loading
  const [patients, setPatients] = useState([]);
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [patientsError, setPatientsError] = useState('');

  // search/pagination over patient list
  const [pSearch, setPSearch] = useState('');
  const [pPage, setPPage] = useState(1);
  const pPageSize = 10;

  // stats from patients
  const [stats, setStats] = useState(null);

  // per-hospital forecast selection
  const [selDisease, setSelDisease] = useState('');
  const [selDistrict, setSelDistrict] = useState('');
  const [fc, setFc] = useState(null);
  const [fcLoading, setFcLoading] = useState(false);
  const [fcError, setFcError] = useState(null);

  // alerts (last N days) filtered by selected disease/district
  const [alSinceDays, setAlSinceDays] = useState('30');
  const [alLimit, setAlLimit] = useState(10);
  const [alPage, setAlPage] = useState(1);
  const [alerts, setAlerts] = useState([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState('');

  // toast
  const [notification, setNotification] = useState({ type: '', message: '' });

  const resetForm = () =>
    setForm({
      _id: null,
      doctorname: '',
      disease: '',
      district: '',
      age: '',
      gender: '',
      symptoms: [],
      temperature: '',
      pulse: '',
      diagnosisDate: null,
    });

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleLogout = () => {
    localStorage.removeItem('user');
    navigate('/');
  };

  //Patients: load & save
  async function fetchPatients() {
    if (!myHospitalId) return;
    setPatientsError('');
    setPatientsLoading(true);
    try {
      //   GET /api/hospital-patients/:hospitalId
      let rows = [];
      try {
        const { data } = await nodeClient.get(`/api/hospital-patients/${encodeURIComponent(myHospitalId)}`);
        rows = Array.isArray(data?.patients) ? data.patients : Array.isArray(data) ? data : [];
      } catch {
        // Fallback: GET /api/patients?hospitalId=...
        const { data } = await nodeClient.get('/api/patients', { params: { hospitalId: myHospitalId, limit: 1000 } });
        rows = Array.isArray(data?.patients) ? data.patients : Array.isArray(data) ? data : [];
      }

      setPatients(rows);
      const s = computeStatsFromPatients(rows);
      setStats(s);

      // Prime selectors if empty
      if (!selDisease) setSelDisease(s.diseaseList?.[0]?.name || diseases?.[0] || '');
      if (!selDistrict) setSelDistrict(s.districts?.[0] || districts?.[0] || '');
    } catch (err) {
      console.error('❌ Fetch patients error:', err);
      setPatientsError(err?.response?.data?.error || 'Failed to fetch patient data.');
    } finally {
      setPatientsLoading(false);
    }
  }

  async function handleSubmit() {
    const {
      _id,
      doctorname,
      disease,
      district,
      age,
      gender,
      symptoms,
      temperature,
      pulse,
      diagnosisDate,
    } = form;

    if (!myHospitalId) {
      setNotification({ type: 'error', message: 'Missing hospital identifier.' });
      return;
    }

    // Minimal required validation
    if (!disease || !district || !gender || !diagnosisDate || (symptoms || []).length === 0) {
      setNotification({ type: 'error', message: 'Please fill all required fields.' });
      return;
    }
    // t0: client submit (latency instrumentation)
    const eventId = newEventId();
    const t0 = Date.now();
    if (DEBUG_LATENCY) {
      console.log(`[LAT] ${eventId} t0=${new Date(t0).toISOString()} (client submit)`);
    }

    const payload = {
      hospitalId: myHospitalId,
      doctorname,
      disease,
      district,
      age: Number(age) || 0,
      gender,
      symptoms,
      temperature: Number(temperature) || 0,
      pulse: Number(pulse) || 0,
      diagnosisDate:
        diagnosisDate instanceof Date ? diagnosisDate.toISOString() : new Date(diagnosisDate).toISOString(),
      ...(DEBUG_LATENCY ? { _latency: { eventId, t0 } } : {}), // carry to backend
    };

    try {
      if (_id) {
        await nodeClient.put(`/api/patients/${encodeURIComponent(_id)}`, payload);
        setNotification({ type: 'success', message: 'Patient updated successfully.' });
      } else {
        await nodeClient.post('/api/patients', payload);
        setNotification({ type: 'success', message: 'Patient saved successfully.' });
      }

      resetForm();
      await fetchPatients();
      // refresh forecast & alerts if selectors are set
      if (selDisease && selDistrict) await loadForecast(false);
      await loadAlerts(1);
    } catch (err) {
      console.error('❌ Submit error:', err?.response?.data || err?.message);
      setNotification({ type: 'error', message: err?.response?.data?.error || 'Failed to save patient.' });
    }
  }

  function handleEdit(p) {
    setForm({
      _id: p._id,
      doctorname: p.doctorname || '',
      disease: p.disease || '',
      district: p.district || '',
      age: p.age ?? '',
      gender: p.gender || '',
      symptoms: Array.isArray(p.symptoms) ? p.symptoms : [],
      temperature: p.temperature ?? '',
      pulse: p.pulse ?? '',
      diagnosisDate: p.diagnosisDate ? new Date(p.diagnosisDate) : null,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  //Forecast and Alerts
  async function loadForecast(force = false) {
    if (!selDisease || !selDistrict) return;
    setFcError(null);
    setFcLoading(true);
    setFc(null);
    try {
      const data = await fetchForecast(selDisease, selDistrict, !!force);
      setFc(data);
    } catch (err) {
      console.error('Forecast error:', err);
      setFcError(err?.response?.data?.detail || err.message || 'Failed to fetch forecast');
    } finally {
      setFcLoading(false);
    }
  }

  async function loadAlerts(page = 1) {
    setAlertsError('');
    setAlertsLoading(true);
    try {
      const skip = (page - 1) * alLimit;
      const params = {
        since_days: Number(alSinceDays || 30),
        limit: alLimit,
        skip,
        withTotal: true,
      };
      if (selDisease) params.disease = selDisease;
      if (selDistrict) params.district = selDistrict;

      const { data } = await fastClient.get('/alerts', { params });
      setAlerts(Array.isArray(data?.items) ? data.items : []);
      setAlertsTotal(Number(data?.total || 0));
      setAlPage(page);
    } catch (err) {
      console.error('Alerts load failed:', err);
      setAlertsError(err?.response?.data?.detail || 'Failed to load alerts');
    } finally {
      setAlertsLoading(false);
    }
  }

  // Effects
  useEffect(() => {
    fetchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myHospitalId]);

  useEffect(() => {
    if (selDisease && selDistrict) loadForecast(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDisease, selDistrict]);

  useEffect(() => {
    loadAlerts(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alSinceDays, alLimit, selDisease, selDistrict]);

  // Derived lists
  const pFiltered = useMemo(() => {
    const s = (pSearch || '').trim().toLowerCase();
    if (!s) return patients;
    return patients.filter(
      (r) =>
        String(r.disease || '').toLowerCase().includes(s) ||
        String(r.district || '').toLowerCase().includes(s) ||
        String(r.doctorname || '').toLowerCase().includes(s)
    );
  }, [patients, pSearch]);

  const pPages = Math.max(1, Math.ceil(pFiltered.length / pPageSize));
  const pSlice = pFiltered.slice((pPage - 1) * pPageSize, pPage * pPageSize);

  const alPages = Math.max(1, Math.ceil((alertsTotal || 0) / alLimit));

  // UI
  return (
    <AppShell>
      <AppShellHeader>
        <Container
          size="xl"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            height: '100%',
            padding: '0 1rem',
            borderBottom: '1px solid #e0e0e0',
            backgroundColor: 'white',
          }}
        >
          <Title order={3}>Hospital Dashboard</Title>
          <Button size="xs" variant="light" color="red" onClick={handleLogout}>
            Logout
          </Button>
        </Container>
      </AppShellHeader>

      <AppShellMain>
        <Container size="xl" mt="xl">
          {/* Welcome */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Title order={4} mb="sm">
              Welcome, {user?.name || user?.username || 'Hospital User'}!
            </Title>
            <Text size="sm" c="dimmed">
              You are logged in as a <strong>{user?.role || 'hospital'}</strong>.
            </Text>
          </Card>

          {/* Case Entry */}
          <Card mt="xl" shadow="sm" padding="lg" radius="md" withBorder>
            <Title order={5}>
              {form._id ? '✏️ Edit Patient' : 'New Patient Case Entry'}
            </Title>

            {metaLoading ? (
              <Loader mt="md" />
            ) : (
              <Grid mt="sm">
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <TextInput
                    label="Doctor Name"
                    value={form.doctorname}
                    onChange={(e) => handleChange('doctorname', e.target.value)}
                    placeholder="Optional"
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="Disease"
                    data={diseases}
                    value={form.disease}
                    onChange={(val) => handleChange('disease', val || '')}
                    placeholder="Select disease"
                    required
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="District"
                    data={districts}
                    value={form.district}
                    onChange={(val) => handleChange('district', val || '')}
                    placeholder="Select district"
                    required
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <NumberInput
                    label="Age"
                    value={form.age}
                    onChange={(val) => handleChange('age', val || '')}
                    allowNegative={false}
                    min={0}
                    max={120}
                    placeholder="Optional"
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="Gender"
                    value={form.gender}
                    onChange={(val) => handleChange('gender', val || '')}
                    data={['Male', 'Female', 'Other']}
                    placeholder="Select gender"
                    required
                  />
                </Grid.Col>

                <Grid.Col span={12}>
                  <MultiSelect
                    label="Symptoms"
                    data={['fever', 'cough', 'headache', 'fatigue', 'rash', 'chills']}
                    value={form.symptoms}
                    onChange={(val) => handleChange('symptoms', val)}
                    searchable
                    creatable
                    getCreateLabel={(query) => `+ Add "${query}"`}
                    required
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <NumberInput
                    label="Temperature (°C)"
                    value={form.temperature}
                    onChange={(val) => handleChange('temperature', val || '')}
                    precision={1}
                    placeholder="Optional"
                  />
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <NumberInput
                    label="Pulse"
                    value={form.pulse}
                    onChange={(val) => handleChange('pulse', val || '')}
                    placeholder="Optional"
                  />
                </Grid.Col>

                <Grid.Col span={12}>
                  <DateInput
                    label="Diagnosis Date"
                    value={form.diagnosisDate}
                    onChange={(val) => handleChange('diagnosisDate', val)}
                    valueFormat="DD/MM/YYYY"
                    required
                  />
                </Grid.Col>
              </Grid>
            )}

            <Group mt="md">
              <Button onClick={handleSubmit}>
                {form._id ? 'Update Patient' : 'Submit Patient'}
              </Button>
              {form._id && (
                <Button variant="outline" color="gray" onClick={resetForm}>
                  Cancel Edit
                </Button>
              )}
            </Group>
          </Card>

          <Divider my="lg" />

          {/* Stats + Forecast */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group justify="space-between" mb="md">
              <Title order={5}>📊 My Stats & Forecast</Title>
              <Button
                size="xs"
                leftSection={<IconRefresh size={16} />}
                variant="light"
                onClick={() => loadForecast(true)}
                disabled={!selDisease || !selDistrict}
              >
                Refresh forecast
              </Button>
            </Group>

            {patientsLoading ? (
              <Loader />
            ) : patientsError ? (
              <Alert color="red" icon={<IconX size={16} />} variant="light">
                {patientsError}
              </Alert>
            ) : (
              <>
                <Group gap="md" mb="sm">
                  <Badge color="grape" variant="light">
                    Total patients: {stats?.totalPatients ?? 0}
                  </Badge>
                  <Badge color="blue" variant="light">
                    Diseases: {stats?.diseaseList?.length ?? 0}
                  </Badge>
                  <Badge color="teal" variant="light">
                    Districts: {stats?.districts?.length ?? 0}
                  </Badge>
                  {stats?.lastReportAt && (
                    <Badge color="gray" variant="light">
                      Last report: {new Date(stats.lastReportAt).toLocaleString()}
                    </Badge>
                  )}
                </Group>

                <Grid gutter="md" mb="md">
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="Disease"
                      placeholder="Select disease"
                      searchable
                      data={(stats?.diseaseList || []).map((d) => ({ value: d.name, label: `${d.name} (${d.total})` }))}
                      value={selDisease}
                      onChange={setSelDisease}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="District"
                      placeholder="Select district"
                      searchable
                      data={(stats?.districts || []).map((d) => ({ value: d, label: d }))}
                      value={selDistrict}
                      onChange={setSelDistrict}
                    />
                  </Grid.Col>
                </Grid>

                <Tabs defaultValue="forecast">
                  <Tabs.List grow>
                    <Tabs.Tab value="forecast">Forecast</Tabs.Tab>
                    <Tabs.Tab value="map">🗺️ Map</Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="forecast" pt="md">
                    <Card withBorder radius="md" p="md">
                      <div style={{ minHeight: 320 }}>
                        <ForecastChart forecast={fc} loading={fcLoading} error={fcError} />
                      </div>
                    </Card>
                  </Tabs.Panel>

                  <Tabs.Panel value="map" pt="md">
                    <div style={{ height: 420 }}>
                      <MapChoropleth forecast={fc} onSelectDistrict={setSelDistrict} />
                    </div>
                  </Tabs.Panel>
                </Tabs>
              </>
            )}
          </Card>

          <Divider my="lg" />

          {/* Alerts (last N days) */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group justify="space-between" mb="md">
              <Title order={5}>⚠ Alerts (last {alSinceDays} days)</Title>
              <Group>
                <Select
                  data={[
                    { value: '7',  label: '7 days' },
                    { value: '14', label: '14 days' },
                    { value: '30', label: '30 days' },
                    { value: '60', label: '60 days' },
                  ]}
                  value={alSinceDays}
                  onChange={setAlSinceDays}
                  w={120}
                />
                <Select
                  data={[
                    { value: '10', label: '10 / page' },
                    { value: '20', label: '20 / page' },
                    { value: '50', label: '50 / page' },
                  ]}
                  value={String(alLimit)}
                  onChange={(v) => setAlLimit(Number(v || 10))}
                  w={130}
                />
                <Button
                  variant="light"
                  leftSection={<IconRefresh size={16} />}
                  onClick={() => loadAlerts(alPage)}
                >
                  Reload
                </Button>
              </Group>
            </Group>

            {alertsLoading ? (
              <Loader />
            ) : alertsError ? (
              <Alert color="red" icon={<IconX size={16} />} variant="light">
                {alertsError}
              </Alert>
            ) : alerts.length === 0 ? (
              <Text size="sm" c="dimmed">No alerts in this window.</Text>
            ) : (
              <>
                <Table striped withTableBorder withColumnBorders highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Date</Table.Th>
                      <Table.Th>Disease</Table.Th>
                      <Table.Th>District</Table.Th>
                      <Table.Th ta="right">Today</Table.Th>
                      <Table.Th ta="right">Yesterday</Table.Th>
                      <Table.Th ta="right">% Change</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {alerts.map((a) => {
                      const id = a._id?.$oid || a._id || `${a.disease}-${a.district}-${a.date}`;
                      const date = a.date ? new Date(a.date).toLocaleDateString() : '—';
                      const pct = Number(a.pct_change ?? a.pctChange ?? 0);
                      return (
                        <Table.Tr key={id}>
                          <Table.Td>{date}</Table.Td>
                          <Table.Td>{a.disease}</Table.Td>
                          <Table.Td>{a.district}</Table.Td>
                          <Table.Td ta="right">{a.today ?? '—'}</Table.Td>
                          <Table.Td ta="right">{a.yesterday ?? '—'}</Table.Td>
                          <Table.Td ta="right" style={{ color: pct >= 30 ? '#e03131' : pct >= 15 ? '#d9480f' : '#2f9e44' }}>
                            {pct.toFixed(1)}%
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>

                <Group justify="space-between" mt="md">
                  <Text size="sm" c="dimmed">
                    Showing {alerts.length} of {alertsTotal} alerts
                  </Text>
                  {alPages > 1 && (
                    <Pagination value={alPage} onChange={(p) => loadAlerts(p)} total={alPages} />
                  )}
                </Group>
              </>
            )}
          </Card>

          <Divider my="lg" />

          {/* Patients list */}
          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Group justify="space-between" mb="md">
              <Title order={5}> Your Submitted Patients</Title>
              <TextInput
                placeholder="Search by doctor, disease or district"
                value={pSearch}
                onChange={(e) => setPSearch(e.currentTarget.value)}
                leftSection={<IconSearch size={16} />}
                w={320}
              />
            </Group>

            {patientsLoading ? (
              <Loader mt="sm" />
            ) : patientsError ? (
              <Alert color="red" icon={<IconX size={16} />} variant="light">
                {patientsError}
              </Alert>
            ) : pFiltered.length === 0 ? (
              <Text size="sm" c="dimmed">No patients found.</Text>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <Table striped highlightOnHover withTableBorder withColumnBorders>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>#</Table.Th>
                        <Table.Th>Date</Table.Th>
                        <Table.Th>Doctor</Table.Th>
                        <Table.Th>Disease</Table.Th>
                        <Table.Th>District</Table.Th>
                        <Table.Th>Age</Table.Th>
                        <Table.Th>Gender</Table.Th>
                        <Table.Th>Temperature</Table.Th>
                        <Table.Th>Pulse</Table.Th>
                        <Table.Th>Symptoms</Table.Th>
                        <Table.Th>Actions</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {pSlice.map((p, idx) => (
                        <Table.Tr key={p._id}>
                          <Table.Td>{(pPage - 1) * pPageSize + idx + 1}</Table.Td>
                          <Table.Td>{p.diagnosisDate ? new Date(p.diagnosisDate).toLocaleDateString() : '—'}</Table.Td>
                          <Table.Td>{p.doctorname || '—'}</Table.Td>
                          <Table.Td>{p.disease || '—'}</Table.Td>
                          <Table.Td>{p.district || '—'}</Table.Td>
                          <Table.Td>{p.age ?? '—'}</Table.Td>
                          <Table.Td>{p.gender || '—'}</Table.Td>
                          <Table.Td>{p.temperature ?? '—'}</Table.Td>
                          <Table.Td>{p.pulse ?? '—'}</Table.Td>
                          <Table.Td>{Array.isArray(p.symptoms) ? p.symptoms.join(', ') : '—'}</Table.Td>
                          <Table.Td>
                            <Button size="xs" variant="light" onClick={() => handleEdit(p)}>
                              Edit
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>

                <Group justify="space-between" mt="md">
                  <Text size="sm" c="dimmed">
                    Showing {pSlice.length} of {pFiltered.length} (total {patients.length})
                  </Text>
                  {pPages > 1 && <Pagination value={pPage} onChange={setPPage} total={pPages} />}
                </Group>
              </>
            )}
          </Card>

          {/* toast */}
          {notification.message && (
            <Notification
              mt="md"
              color={notification.type === 'success' ? 'teal' : 'red'}
              icon={notification.type === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
              onClose={() => setNotification({ type: '', message: '' })}
              withCloseButton
            >
              {notification.message}
            </Notification>
          )}
        </Container>
      </AppShellMain>
    </AppShell>
  );
}