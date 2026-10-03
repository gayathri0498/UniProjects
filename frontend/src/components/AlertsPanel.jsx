import React, { useEffect, useState } from 'react';
import { Card, Text, Badge, Group, Loader } from '@mantine/core';
import { fetchAlerts } from '../api';

export default function AlertsPanel({ disease, district }) {
  const [state, setState] = useState({ items: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: null }));
    fetchAlerts({ disease, district, since_days: 30, limit: 20 })
      .then(data => !cancelled && setState({ items: data.items || [], loading: false, error: null }))
      .catch(err => !cancelled && setState({ items: [], loading: false, error: err }));
    return () => { cancelled = true; };
  }, [disease, district]);

  if (state.loading) return <Card withBorder radius="md" p="md"><Loader size="sm" /></Card>;
  if (state.error)   return <Card withBorder radius="md" p="md"><Text c="red">Couldn’t load alerts.</Text></Card>;
  if (!state.items.length) {
    return (
      <Card withBorder radius="md" p="md">
        <Text ta="center" c="teal">No alerts in the last 30 days.</Text>
      </Card>
    );
  }

  return (
    <Card withBorder radius="md" p="md">
      <Group position="apart" mb="xs">
        <Text fw={600}>Recent Alerts</Text>
        {disease && district && (
          <Badge variant="light">{disease} — {district}</Badge>
        )}
      </Group>
      <div style={{ display: 'grid', gap: 10 }}>
        {state.items.map((a, i) => {
          const sev = String(a.severity || '').toLowerCase();
          const color = sev === 'high' ? 'red' : sev === 'medium' ? 'yellow' : 'green';
          const when  = a.date ? new Date(a.date).toLocaleDateString() : '—';
          const pct   = typeof a.pct_change === 'number' ? `${a.pct_change.toFixed(1)}%` : '—';
          return (
            <Card key={i} withBorder padding="sm" radius="sm">
              <Group position="apart" spacing="xs">
                <Group spacing="xs">
                  <Badge color={color} variant="filled">{sev || 'info'}</Badge>
                  <Text fw={600}>{a.disease} — {a.district}</Text>
                </Group>
                <Text c="dimmed" size="sm">{when}</Text>
              </Group>
              <Text size="sm" mt={6}>
                Today: <b>{a.today ?? '—'}</b>, Yesterday: <b>{a.yesterday ?? '—'}</b>, Change: <b>{pct}</b>
              </Text>
            </Card>
          );
        })}
      </div>
    </Card>
  );
}