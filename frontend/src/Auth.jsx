import React, { useState } from 'react';
import {
  Container,
  Card,
  TextInput,
  PasswordInput,
  Button,
  Tabs,
  Select,
  Text,
  Title,
  Notification,
} from '@mantine/core';
import { IconUserPlus, IconLogin, IconCheck, IconX } from '@tabler/icons-react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

export default function Auth() {
  const [activeTab, setActiveTab] = useState('login');
  const [form, setForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    role: '',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  const handleChange = (field, value) => {
    setForm({ ...form, [field]: value });
    setError('');
    setSuccess('');
  };

  const resetForm = () => {
    setForm({
      username: '',
      password: '',
      confirmPassword: '',
      role: '',
    });
  };

  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
    resetForm();
    setError('');
    setSuccess('');
  };

  const handleRegister = async () => {
    const { username, password, confirmPassword, role } = form;
    if (!username || !password || !confirmPassword || !role) {
      setError('All fields are required');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      await axios.post('http://localhost:5000/api/register', {
        username,
        password,
        confirmPassword,
        role,
      });

      setSuccess(
        role === 'hospital'
          ? 'Registered successfully! Awaiting admin approval.'
          : 'Registered successfully! You can now log in.'
      );
      setActiveTab('login');
      resetForm();
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    }
  };

  const handleLogin = async () => {
    const { username, password } = form;
    if (!username || !password) {
      setError('Username and password are required');
      return;
    }

    try {
      const res = await axios.post('http://localhost:5000/api/login', { username, password });
      const user = res.data.user;
      localStorage.setItem('user', JSON.stringify(user));

      if (user.role === 'admin') {
        navigate('/admin-dashboard');
      } else if (user.role === 'hospital') {
        navigate('/hospital-dashboard');
      } else {
        setError('Unknown user role');
      }
    } catch (err) {
      if (err.response?.status === 403) {
        setError('Awaiting admin approval. Please try again later.');
      } else {
        setError(err.response?.data?.error || 'Login failed');
      }
    }
  };

  return (
    <Container size={420} my={40}>
      <Title ta="center" mb={20}>
        Welcome to RTESS
      </Title>
      <Card shadow="md" p={30} radius="md" withBorder>
        <Tabs value={activeTab} onChange={handleTabSwitch}>
          <Tabs.List grow>
            <Tabs.Tab value="login" icon={<IconLogin size={16} />}>
              Login
            </Tabs.Tab>
            <Tabs.Tab value="register" icon={<IconUserPlus size={16} />}>
              Register
            </Tabs.Tab>
          </Tabs.List>

          {/* ───────────── Register ───────────── */}
          <Tabs.Panel value="register" pt="xs">
            <TextInput
              label="Username"
              placeholder="Hospital name or admin ID"
              value={form.username}
              onChange={(e) => handleChange('username', e.target.value)}
              required
              mb="sm"
            />
            <PasswordInput
              label="Password"
              value={form.password}
              onChange={(e) => handleChange('password', e.target.value)}
              required
              mb="sm"
            />
            <PasswordInput
              label="Confirm Password"
              value={form.confirmPassword}
              onChange={(e) => handleChange('confirmPassword', e.target.value)}
              required
              mb="sm"
            />
            <Select
              label="Role"
              placeholder="Select role"
              data={[
                { value: 'admin', label: 'Admin' },
                { value: 'hospital', label: 'Hospital' },
              ]}
              value={form.role}
              onChange={(val) => handleChange('role', val)}
              required
              mb="sm"
            />
            <Button fullWidth mt="md" onClick={handleRegister}>
              Register
            </Button>
          </Tabs.Panel>

          {/* ───────────── Login ───────────── */}
          <Tabs.Panel value="login" pt="xs">
            <TextInput
              label="Username"
              placeholder="Your username"
              value={form.username}
              onChange={(e) => handleChange('username', e.target.value)}
              required
              mb="sm"
            />
            <PasswordInput
              label="Password"
              value={form.password}
              onChange={(e) => handleChange('password', e.target.value)}
              required
              mb="sm"
            />
            <Button fullWidth mt="md" onClick={handleLogin}>
              Login
            </Button>
          </Tabs.Panel>
        </Tabs>

        {error && (
          <Notification mt="md" color="red" icon={<IconX size={16} />} title="Error" disallowClose>
            {error}
          </Notification>
        )}
        {success && (
          <Notification mt="md" color="teal" icon={<IconCheck size={16} />} title="Success" disallowClose>
            {success}
          </Notification>
        )}
      </Card>
    </Container>
  );
}