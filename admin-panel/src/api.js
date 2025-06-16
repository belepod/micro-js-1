import axios from 'axios';

const api = axios.create({
    baseURL: 'http://localhost:3003', // Our tenant-manager URL
    withCredentials: true, // IMPORTANT: This sends the session cookie
});

export const login = (username, password) => api.post('/login', { username, password });
export const fetchTenants = () => api.get('/tenants');
export const fetchTenantDetails = (tenantId) => api.get(`/tenants/${tenantId}`);
export const createTenant = (formData) => {
    return api.post('/tenants', formData, {
        headers: {
            'Content-Type': 'multipart/form-data',
        },
    });
};
export const deleteTenant = (tenantId) => api.delete(`/tenants/${tenantId}`);
export const renameTenant = (oldId, newId) => api.put(`/tenants/${oldId}`, { newTenantId: newId });
