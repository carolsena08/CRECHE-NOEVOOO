const axios = require('axios');
require('dotenv').config();

// Cria uma instância do Axios pré-configurada para a API do Asaas
const asaasAPI = axios.create({
    baseURL: process.env.ASAAS_API_URL,
    headers: {
        'Content-Type': 'application/json',
        'access_token': process.env.ASAAS_API_KEY
    }
});

// --- FUNÇÕES QUE SERÃO PUXADAS PELA API ---

/**
 * @description Busca todos os clientes (alunos) cadastrados no Asaas.
 * @returns {Promise<Array>} Lista de clientes.
 */
const getClientes = async () => {
    try {
        const response = await asaasAPI.get('/customers');
        return response.data.data;
    } catch (error) {
        console.error("Erro ao buscar clientes no Asaas:", error.response.data);
        return [];
    }
};

/**
 * @description Busca todas as cobranças (receitas) no Asaas.
 * @returns {Promise<Array>} Lista de cobranças.
 */

const getCobrancas = async () => {
    try {
        // Você pode adicionar filtros aqui, como ?status=PAID ou ?status=PENDING
        const response = await asaasAPI.get('/payments');
        return response.data.data;
    } catch (error) {
        console.error("Erro ao buscar cobranças no Asaas:", error.response.data);
        return [];
    }
};

/**
 * @description Cria uma nova cobrança (mensalidade) no Asaas.
 * @param {Object} dadosCobranca - Dados da cobrança a ser criada.
 * @returns {Promise<Object>} A cobrança criada.
 */
const criarCobranca = async (dadosCobranca) => {
    try {
        const response = await asaasAPI.post('/payments', dadosCobranca);
        return response.data;
    } catch (error) {
        console.error("Erro ao criar cobrança no Asaas:", error.response.data);
        throw error;
    }
};

// Adicione aqui outras funções conforme necessário (ex: buscar despesas, criar clientes, etc.)

module.exports = {
    getClientes,
    getCobrancas,
    criarCobranca
};