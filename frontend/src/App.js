// src/App.js
import React, { useState, useEffect } from 'react';
import {
  AppShell,
  AppShellHeader,
  AppShellMain,
  Container,
  Title,
  Text,
  Grid,
  Card,
  Select,
  Loader,
  Center,
  Button,
  Tabs,
  Divider,
  Transition,
  SegmentedControl,
  Group,
  Badge,
  Box,
} from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useNavigate, useLocation } from 'react-router-dom';

import useMetadata from './hooks/useMetadata';
import useForecast from './hooks/useForecast';
import { fetchAlerts } from './api';
import MapChoropleth from './components/MapChoropleth';
import ForecastChart from './components/ForecastChart';
function getForecastAlerts(forecastObj) {
  const preds = Array.isArray(forecastObj?.predictions) ? forecastObj.predictions : [];
  if (preds.length < 2) return [];

  const prev = preds[preds.length - 2];
  const curr = preds[preds.length - 1];

  const prevY = Number(prev?.yhat ?? prev?.y ?? 0);
  const currY = Number(curr?.yhat ?? curr?.y ?? 0);
  const pct = ((currY - prevY) / (prevY || 1)) * 100;

  // Simple “spike alert” rule: ≥50% jump and at least 50 cases
  if (pct >= 50 && currY >= 50) {
    return [
      {
        date: curr?.ds || curr?.x || '',
        message: `⚠️ Spike alert: ${Math.round(currY)} forecasted on ${curr?.ds || curr?.x} (+${pct.toFixed(1)}%)`,
      },
    ];
  }
  return [];
}

export default function App() {
  const {
    metadata: { diseases = [], districts = [] },
    loading: metaLoading,
    error: metaError,
  } = useMetadata();

  const navigate = useNavigate();
  const location = useLocation();

  // Restore last selections
  const [disease, setDisease] = useState(() => localStorage.getItem('disease') || '');
  const [district, setDistrict] = useState(() => localStorage.getItem('district') || '');

  // Forecast for current selection
  const { data: forecast, loading: fcLoading, error: fcError } = useForecast(disease, district);
  const spikeAlerts = getForecastAlerts(forecast);

  // Backend alerts 
  const [alertsItems, setAlertsItems] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsError, setAlertsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadAlerts() {
      if (!disease || !district) {
        setAlertsItems([]);
        setAlertsError(null);
        return;
      }
      setAlertsLoading(true);
      setAlertsError(null);
      try {
        // Last 30 days, top 20; withTotal for potential pagination later
        const res = await fetchAlerts({
          disease,
          district,
          since_days: 30,
          limit: 20,
          skip: 0,
          withTotal: true,
        });
        if (!cancelled) setAlertsItems(res.items || []);
      } catch (err) {
        if (!cancelled) setAlertsError(err);
      } finally {
        if (!cancelled) setAlertsLoading(false);
      }
    }
    loadAlerts();
    return () => { cancelled = true; };
  }, [disease, district]);

  let user = null;
  try {
    const stored = localStorage.getItem('user');
    user = stored ? JSON.parse(stored) : null;
  } catch {
    localStorage.removeItem('user');
  }
  const isLoggedIn = !!user;

  const handleLogout = () => {
    localStorage.removeItem('user');
    navigate('/');
    window.location.reload();
  };

  const getInitialView = () => {
    if (location.pathname === '/admin-dashboard') return 'Admin';
    if (location.pathname === '/hospital-dashboard') return 'Hospital';
    return 'Public';
  };
  const [viewMode, setViewMode] = useState(getInitialView);

  const handleViewChange = (value) => {
    setViewMode(value);
    if (value === 'Admin') navigate('/admin-dashboard');
    else if (value === 'Hospital') navigate('/hospital-dashboard');
    else navigate('/');
  };

  useEffect(() => {
    if (!metaLoading && !metaError) {
      if (!disease && diseases.length) setDisease(diseases[0]);
      if (!district && districts.length) setDistrict(districts[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaLoading, metaError, diseases, districts]);

  // Persist selection
  useEffect(() => {
    if (disease) localStorage.setItem('disease', disease);
  }, [disease]);
  useEffect(() => {
    if (district) localStorage.setItem('district', district);
  }, [district]);

  // Loading/error states for metadata
  if (metaLoading) {
    return (
      <Center style={{ height: '100vh' }}>
        <Loader size="lg" />
      </Center>
    );
  }
  if (metaError) {
    return (
      <Center style={{ height: '100vh' }}>
        <Text c="red">Failed to load metadata.</Text>
      </Center>
    );
  }

  return (
    <AppShell
      padding="md"
      header={
        <AppShellHeader style={{ backgroundColor: '#f9f9f9', paddingBottom: '0.5rem' }}>
          <Container size="xl">
            <Box mt="md" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Title order={2} style={{ fontSize: 'clamp(1.5rem, 2vw, 2.5rem)' }}>
                🩺 RTESS Dashboard
              </Title>

              {isLoggedIn ? (
                <Group gap="xs">
                  <Badge color="blue" size="sm">
                    👤 {user.name} ({user.role})
                  </Badge>
                  <Button size="xs" variant="light" color="red" onClick={handleLogout}>
                    Logout
                  </Button>
                </Group>
              ) : (
                <Button
                  size="xs"
                  variant="light"
                  color="blue"
                  radius="sm"
                  style={{ fontWeight: 500 }}
                  onClick={() => navigate('/auth')}
                >
                  Login / Register
                </Button>
              )}
            </Box>
          </Container>
        </AppShellHeader>
      }
    >
      {/* View switcher */}
      <Container size="xl" mt="xs">
        <SegmentedControl
          fullWidth
          value={viewMode}
          onChange={handleViewChange}
          data={['Admin', 'Hospital', 'Public']}
          radius="md"
          color="blue"
        />
      </Container>

      {/* Public hero */}
      {viewMode === 'Public' && (
        <Container size="xl" mt="md">
          <Card
            withBorder
            radius="md"
            shadow="lg"
            p="xl"
            style={{
              background: 'linear-gradient(135deg, #edf5ff, #e6f7ff)',
              textAlign: 'center',
              transition: 'transform 0.3s ease',
            }}
          >
            <Title order={2} mb="xs" style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)' }}>
              🧠 Real-Time Epidemic Surveillance System
            </Title>
            <Text size="md" c="dimmed" mb="md">
              Monitoring disease outbreaks across Tamil Nadu – powered by AI & GIS
            </Text>
            <Button size="md" color="blue" component="a" href="#dashboard">
              🚀 Explore Dashboard
            </Button>
          </Card>
        </Container>
      )}

      <AppShellMain>
        <Container size="xl" mt="xl" id="dashboard">
          <Grid gutter="md">
            {/* Filters */}
            <Grid.Col span={12}>
              <Card shadow="md" padding="md" radius="md" withBorder>
                <Grid gutter="md">
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="🦠 Disease"
                      placeholder="Select disease"
                      searchable
                      data={diseases.map((d) => ({ value: d, label: d }))}
                      value={disease}
                      onChange={setDisease}
                      rightSection={<IconChevronDown size="1rem" />}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, sm: 6 }}>
                    <Select
                      label="📍 District"
                      placeholder="Select district"
                      searchable
                      data={districts.map((d) => ({ value: d, label: d }))}
                      value={district}
                      onChange={setDistrict}
                      rightSection={<IconChevronDown size="1rem" />}
                    />
                  </Grid.Col>
                </Grid>
              </Card>
            </Grid.Col>

            {/* Backend Alerts Panel */}
            <Grid.Col span={12}>
              <Card shadow="sm" padding="md" radius="md" withBorder>
                <Title order={4} mb="xs">⚠️ Alerts (last 30 days)</Title>
                {alertsLoading && <Loader size="sm" />}
                {!alertsLoading && alertsError && (
                  <Text c="red" size="sm">Couldn’t load alerts.</Text>
                )}
                {!alertsLoading && !alertsError && alertsItems.length === 0 && (
                  <Text c="teal" size="sm">No alerts for {disease || '—'} in {district || '—'}.</Text>
                )}
                {!alertsLoading && !alertsError && alertsItems.length > 0 && (
                  <ul style={{ paddingLeft: '1.2rem', margin: 0 }}>
                    {alertsItems.map((a, idx) => {
                      const d = a?.date ? new Date(a.date) : null;
                      const dateStr = d ? d.toLocaleDateString() : '—';
                      const today = Number(a?.today ?? a?.count ?? 0);
                      const yest  = Number(a?.yesterday ?? 0);
                      const pct   = Number(a?.pct_change ?? 0);
                      const rule  = a?.rule || {};
                      const minCases = rule?.minCases ?? '-';
                      const thrPct   = rule?.thresholdPct ?? '-';
                      return (
                        <li key={idx} style={{ marginBottom: 6 }}>
                          <Text size="sm">
                            <strong>{dateStr}</strong> — {a?.disease}/{a?.district} &nbsp;
                            today: <strong>{today}</strong>, yesterday: {yest}, Δ%: {pct.toFixed ? pct.toFixed(1) : pct}%
                            &nbsp; (rule: ≥ {minCases} & cases and ≥ {thrPct}%)
                          </Text>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </Grid.Col>

            {/* Optional forecast “spike” banner (derived from forecast) */}
            {['Public', 'Hospital'].includes(viewMode) && spikeAlerts.length > 0 && (
              <Grid.Col span={12}>
                <Transition mounted transition="fade" duration={400} timingFunction="ease">
                  {(styles) => (
                    <Card shadow="sm" padding="md" radius="md" withBorder style={{ ...styles, backgroundColor: '#fff4f4' }}>
                      <Title order={4} c="red" mb="xs">
                       Forecast Spike Alert
                      </Title>
                      <ul style={{ paddingLeft: '1.2rem', margin: 0 }}>
                        {spikeAlerts.map((alert, idx) => (
                          <li key={idx}>
                            <Text c="red" size="sm">
                              {alert.message}
                            </Text>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                </Transition>
              </Grid.Col>
            )}

            {/* Title row */}
            <Grid.Col span={12}>
              <Card shadow="sm" padding="md" radius="md" withBorder>
                <Text ta="center" size="md" fw={500}>
                  Forecasting <strong>{disease || '—'}</strong> in <strong>{district || '—'}</strong>
                </Text>
              </Card>
            </Grid.Col>

            {/* Map / Chart tabs */}
            <Grid.Col span={12}>
              <Card shadow="sm" padding="md" radius="md" withBorder>
                <Tabs defaultValue="map">
                  <Tabs.List grow>
                    <Tabs.Tab value="map">🗺️ Map</Tabs.Tab>
                    <Tabs.Tab value="forecast">📈 Forecast</Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="map" pt="md">
                    <div style={{ height: 450 }}>
                      <MapChoropleth forecast={forecast} onSelectDistrict={setDistrict} />
                    </div>
                  </Tabs.Panel>

                  <Tabs.Panel value="forecast" pt="md">
                    <div style={{ minHeight: 340 }}>
                      <ForecastChart forecast={forecast} loading={fcLoading} error={fcError} />
                    </div>
                  </Tabs.Panel>
                </Tabs>
              </Card>
            </Grid.Col>
          </Grid>
        </Container>

        <Container size="xl" mt="lg">
          <Divider my="sm" />
          <Text ta="center" size="xs" c="dimmed">
            © {new Date().getFullYear()} Built by Gayathri Ramakrishnan, NTU MSc Cloud & Enterprise Computing
          </Text>
        </Container>
      </AppShellMain>
    </AppShell>
  );
}